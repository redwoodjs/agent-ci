import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import type { RequestInfo } from "rwsdk/worker";

export async function IngestionListPage({ request }: { request: Request }) {
  const bucket = env.MACHINEN_BUCKET;
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "all";
  const cursor = url.searchParams.get("cursor") || undefined;

  let prefix = "";
  if (source === "discord") prefix = "discord/";
  else if (source === "github") prefix = "github/";
  else if (source === "cursor") prefix = "cursor/";

  const listOptions: any = {
    limit: 100,
    ...(prefix && { prefix }),
    ...(cursor && { cursor }),
  };

  const list = await bucket.list(listOptions);

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
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Key
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Size
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Last Modified
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    ETag
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.objects.map((obj) => (
                  <tr key={obj.key} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm font-mono">{obj.key}</td>
                    <td className="py-3 px-4 text-sm">
                      {formatBytes(obj.size)}
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {obj.uploaded.toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-sm font-mono text-xs text-gray-500">
                      {obj.etag.substring(0, 16)}...
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {list.truncated && (
            <div className="mt-4 flex justify-between items-center">
              <div className="text-sm text-gray-500">
                Showing {list.objects.length} files
              </div>
              <a
                href={`/audit/ingestion?source=${source}&cursor=${list.cursor}`}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Load More
              </a>
            </div>
          )}

          {!list.truncated && list.objects.length > 0 && (
            <div className="mt-4 text-sm text-gray-500">
              Showing all {list.objects.length} files
            </div>
          )}

          {list.objects.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              No files found
              {prefix && ` with prefix "${prefix}"`}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}
