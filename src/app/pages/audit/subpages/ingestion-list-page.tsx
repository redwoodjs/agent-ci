import { Suspense } from "react";
import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { IngestionTable } from "./ingestion-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

export function IngestionListPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "all";
  const pageParam = url.searchParams.get("page") || "1";
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
  const q = url.searchParams.get("q") || "";
  const namespace = url.searchParams.get("namespace") || undefined;
  const prefixParam = url.searchParams.get("prefix") || undefined;

  let prefix = "";
  if (source === "discord") prefix = "discord/";
  else if (source === "github") prefix = "github/";
  else if (source === "cursor") prefix = "cursor/";
  else if (source === "antigravity") prefix = "antigravity/";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Ingestion Files</h1>

        <div className="flex gap-2">
          <a
            href={`/audit/ingestion?source=all${namespace ? `&namespace=${namespace}` : ""
              }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
            className={`px-4 py-2 rounded ${source === "all"
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
          >
            All
          </a>
          <a
            href={`/audit/ingestion?source=discord${namespace ? `&namespace=${namespace}` : ""
              }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
            className={`px-4 py-2 rounded ${source === "discord"
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
          >
            Discord
          </a>
          <a
            href={`/audit/ingestion?source=github${namespace ? `&namespace=${namespace}` : ""
              }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
            className={`px-4 py-2 rounded ${source === "github"
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
          >
            GitHub
          </a>
          <a
            href={`/audit/ingestion?source=cursor${namespace ? `&namespace=${namespace}` : ""
              }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
            className={`px-4 py-2 rounded ${source === "cursor"
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
          >
            Cursor
          </a>
          <a
            href={`/audit/ingestion?source=antigravity${namespace ? `&namespace=${namespace}` : ""
              }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
            className={`px-4 py-2 rounded ${source === "antigravity"
              ? "bg-blue-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
              }`}
          >
            Antigravity
          </a>
        </div>
      </div>

      <Card className="mb-6">
        <CardContent className="pt-6">
          <form
            method="GET"
            action="/audit/ingestion"
            className="grid grid-cols-1 md:grid-cols-4 gap-4"
          >
            <input type="hidden" name="source" value={source} />
            <div className="md:col-span-2">
              <label className="text-sm font-medium mb-1 block">
                Filter by Path
              </label>
              <Input
                name="q"
                defaultValue={q}
                key={q || "empty-q"}
                placeholder="Filter by file path..."
                className="w-full"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">
                Namespace
              </label>
              <Select
                name="namespace"
                defaultValue={namespace || "all"}
                key={namespace || "all"}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select namespace" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Default (All)</SelectItem>
                  <SelectItem value="redwood:machinen">
                    redwood:machinen
                  </SelectItem>
                  <SelectItem value="redwood:rwsdk">redwood:rwsdk</SelectItem>
                  <SelectItem value="redwood:internal">
                    redwood:internal
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">
                Prefix Override
              </label>
              <Input
                name="prefix"
                defaultValue={prefixParam}
                key={prefixParam || "empty-prefix"}
                placeholder="e.g. demo-2026-01-06"
                className="w-full font-mono"
              />
            </div>
            <div className="md:col-span-4 flex justify-end gap-2">
              <Button type="submit">Apply Filters</Button>
              {(q || namespace || prefixParam) && (
                <Button variant="outline" asChild>
                  <a href={`/audit/ingestion?source=${source}`}>Clear</a>
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>

      <Suspense fallback={<FilesTableSkeleton prefix={prefix} />}>
        <FilesTable
          source={source}
          prefix={prefix}
          page={page}
          pageSize={50}
          q={q}
          namespace={namespace}
          prefixParam={prefixParam}
        />
      </Suspense>
    </div>
  );
}

async function FilesTable({
  source,
  prefix,
  page,
  pageSize,
  q,
  namespace,
  prefixParam,
}: {
  source: string;
  prefix: string;
  page: number;
  pageSize: number;
  q: string;
  namespace?: string;
  prefixParam?: string;
}) {
  const bucket = env.MACHINEN_BUCKET;

  // Load all objects for the current prefix by following cursors.
  const baseListOptions: any = {
    ...(prefix && { prefix }),
  };

  const allObjects: any[] = [];
  let cursor: string | undefined = undefined;
  do {
    const list = await bucket.list({
      ...baseListOptions,
      cursor,
    } as any);

    allObjects.push(...list.objects);
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);

  // Sort on the server by last modified (uploaded) so newest files are first.
  const sortedObjects = [...allObjects].sort((a, b) => {
    const aTime =
      a.uploaded instanceof Date
        ? a.uploaded.getTime()
        : new Date(a.uploaded as any).getTime();
    const bTime =
      b.uploaded instanceof Date
        ? b.uploaded.getTime()
        : new Date(b.uploaded as any).getTime();
    return bTime - aTime;
  });

  const filteredObjects = q
    ? sortedObjects.filter((obj) =>
      obj.key.toLowerCase().includes(q.toLowerCase())
    )
    : sortedObjects;

  // Serialize objects for client component, ensuring we only pass plain data.
  // We explicitly select fields to avoid passing non-serializable objects like R2's Checksums.
  const serializedObjects = filteredObjects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    etag: obj.etag,
    uploaded:
      obj.uploaded instanceof Date
        ? obj.uploaded.toISOString()
        : typeof obj.uploaded === "string"
          ? obj.uploaded
          : new Date(obj.uploaded as any).toISOString(),
  }));

  const totalItems = serializedObjects.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  const pageObjects = serializedObjects.slice(startIndex, endIndex);

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Files in R2{prefix && ` (${prefix.replace("/", "")})`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <IngestionTable
          objects={pageObjects}
          namespace={namespace}
          prefixParam={prefixParam}
        />

        {totalItems > 0 && (
          <div className="mt-4 text-sm text-gray-500">
            Showing {startIndex + 1}
            {"–"}
            {endIndex} of {totalItems} files
          </div>
        )}

        <div className="mt-4 flex justify-between items-center">
          <div className="text-sm text-gray-500">
            Page {currentPage} of {totalPages}
          </div>
          <div className="flex gap-2">
            {currentPage > 1 && (
              <a
                href={`/audit/ingestion?source=${source}&page=${currentPage - 1
                  }${q ? `&q=${q}` : ""}${namespace ? `&namespace=${namespace}` : ""
                  }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              >
                Previous
              </a>
            )}
            {currentPage < totalPages && (
              <a
                href={`/audit/ingestion?source=${source}&page=${currentPage + 1
                  }${q ? `&q=${q}` : ""}${namespace ? `&namespace=${namespace}` : ""
                  }${prefixParam ? `&prefix=${prefixParam}` : ""}`}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Next
              </a>
            )}
          </div>
        </div>

        {totalItems === 0 && (
          <div className="text-center py-8 text-gray-500">
            No files found
            {prefix && ` with prefix "${prefix}"`}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function FilesTableSkeleton({ prefix }: { prefix: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          Files in R2{prefix && ` (${prefix.replace("/", "")})`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b">
              <tr>
                {[1, 2, 3, 4].map((i) => (
                  <th
                    key={i}
                    className="text-left py-3 px-4 font-medium text-sm text-gray-500"
                  >
                    <div className="h-4 w-20 bg-gray-200 rounded animate-pulse" />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
                <tr key={i} className="border-b">
                  {[1, 2, 3, 4].map((j) => (
                    <td key={j} className="py-3 px-4">
                      <div className="h-4 w-full bg-gray-200 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
