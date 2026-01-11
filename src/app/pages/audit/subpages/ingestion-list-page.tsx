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

export function IngestionListPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "all";
  const pageParam = url.searchParams.get("page") || "1";
  const page = Math.max(1, Number.parseInt(pageParam, 10) || 1);
  const q = url.searchParams.get("q") || "";

  let prefix = "";
  if (source === "discord") prefix = "discord/";
  else if (source === "github") prefix = "github/";
  else if (source === "cursor") prefix = "cursor/";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Ingestion Files</h1>

        <div className="flex gap-2">
          <a
            href="/audit/ingestion?source=all"
            className={`px-4 py-2 rounded ${
              source === "all"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            All
          </a>
          <a
            href="/audit/ingestion?source=discord"
            className={`px-4 py-2 rounded ${
              source === "discord"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Discord
          </a>
          <a
            href="/audit/ingestion?source=github"
            className={`px-4 py-2 rounded ${
              source === "github"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            GitHub
          </a>
          <a
            href="/audit/ingestion?source=cursor"
            className={`px-4 py-2 rounded ${
              source === "cursor"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Cursor
          </a>
        </div>
      </div>

      <form
        method="GET"
        action="/audit/ingestion"
        className="flex gap-2 mb-4 max-w-lg"
      >
        <input type="hidden" name="source" value={source} />
        <Input
          name="q"
          defaultValue={q}
          placeholder="Filter by file path..."
          className="flex-1"
        />
        <Button type="submit">Filter</Button>
        {q && (
          <Button variant="outline" asChild>
            <a href={`/audit/ingestion?source=${source}`}>Clear</a>
          </Button>
        )}
      </form>

      <Suspense fallback={<FilesTableSkeleton prefix={prefix} />}>
        <FilesTable
          source={source}
          prefix={prefix}
          page={page}
          pageSize={50}
          q={q}
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
}: {
  source: string;
  prefix: string;
  page: number;
  pageSize: number;
  q: string;
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
        <IngestionTable objects={pageObjects} />

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
                href={`/audit/ingestion?source=${source}&page=${
                  currentPage - 1
                }${q ? `&q=${q}` : ""}`}
                className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
              >
                Previous
              </a>
            )}
            {currentPage < totalPages && (
              <a
                href={`/audit/ingestion?source=${source}&page=${
                  currentPage + 1
                }${q ? `&q=${q}` : ""}`}
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
