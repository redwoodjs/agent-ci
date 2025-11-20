import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import { getIndexingStatesBatch } from "@/app/engine/db";
import type { RequestInfo } from "rwsdk/worker";

export async function IndexingStatusPage({ request }: { request: Request }) {
  const bucket = env.MACHINEN_BUCKET;
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "all";
  const statusFilter = url.searchParams.get("status") || "all";

  let prefix = "";
  if (source === "discord") prefix = "discord/";
  else if (source === "github") prefix = "github/";
  else if (source === "cursor") prefix = "cursor/";

  const listOptions: any = {
    limit: 500,
    ...(prefix && { prefix }),
  };

  const list = await bucket.list(listOptions);
  const allKeys = list.objects.map((obj) => obj.key);

  // Get indexing states
  const indexingStates = await getIndexingStatesBatch(allKeys);

  // Build combined view
  const files = list.objects.map((obj) => {
    const indexingState = indexingStates.get(obj.key);
    return {
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
      etag: obj.etag,
      indexed: !!indexingState,
      indexedAt: indexingState?.indexed_at,
      indexedEtag: indexingState?.etag,
      chunkCount: indexingState?.chunk_ids?.length || 0,
      needsReindex: indexingState ? indexingState.etag !== obj.etag : false,
    };
  });

  // Filter by status
  const filteredFiles = files.filter((file) => {
    if (statusFilter === "indexed") return file.indexed && !file.needsReindex;
    if (statusFilter === "pending") return !file.indexed;
    if (statusFilter === "stale") return file.needsReindex;
    return true;
  });

  const stats = {
    total: files.length,
    indexed: files.filter((f) => f.indexed && !f.needsReindex).length,
    pending: files.filter((f) => !f.indexed).length,
    stale: files.filter((f) => f.needsReindex).length,
  };

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Indexing Status</h1>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Total Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.total}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Indexed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {stats.indexed}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Pending
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">
              {stats.pending}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Needs Reindex
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">{stats.stale}</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <div className="flex gap-2">
          <span className="text-sm font-medium text-gray-700 self-center">
            Source:
          </span>
          <a
            href={`/audit/indexing?source=all&status=${statusFilter}`}
            className={`px-3 py-1 text-sm rounded ${
              source === "all"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            All
          </a>
          <a
            href={`/audit/indexing?source=discord&status=${statusFilter}`}
            className={`px-3 py-1 text-sm rounded ${
              source === "discord"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Discord
          </a>
          <a
            href={`/audit/indexing?source=github&status=${statusFilter}`}
            className={`px-3 py-1 text-sm rounded ${
              source === "github"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            GitHub
          </a>
          <a
            href={`/audit/indexing?source=cursor&status=${statusFilter}`}
            className={`px-3 py-1 text-sm rounded ${
              source === "cursor"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Cursor
          </a>
        </div>

        <div className="flex gap-2">
          <span className="text-sm font-medium text-gray-700 self-center">
            Status:
          </span>
          <a
            href={`/audit/indexing?source=${source}&status=all`}
            className={`px-3 py-1 text-sm rounded ${
              statusFilter === "all"
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            All
          </a>
          <a
            href={`/audit/indexing?source=${source}&status=indexed`}
            className={`px-3 py-1 text-sm rounded ${
              statusFilter === "indexed"
                ? "bg-green-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Indexed
          </a>
          <a
            href={`/audit/indexing?source=${source}&status=pending`}
            className={`px-3 py-1 text-sm rounded ${
              statusFilter === "pending"
                ? "bg-orange-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Pending
          </a>
          <a
            href={`/audit/indexing?source=${source}&status=stale`}
            className={`px-3 py-1 text-sm rounded ${
              statusFilter === "stale"
                ? "bg-red-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Stale
          </a>
        </div>
      </div>

      {/* Files Table */}
      <Card>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Key
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Status
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Chunks
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Indexed At
                  </th>
                  <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                    Last Modified
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredFiles.map((file) => (
                  <tr key={file.key} className="border-b hover:bg-gray-50">
                    <td className="py-3 px-4 text-sm font-mono max-w-md truncate">
                      {file.key}
                    </td>
                    <td className="py-3 px-4 text-sm">
                      {file.needsReindex ? (
                        <span className="px-2 py-1 bg-red-100 text-red-800 rounded text-xs">
                          Needs Reindex
                        </span>
                      ) : file.indexed ? (
                        <span className="px-2 py-1 bg-green-100 text-green-800 rounded text-xs">
                          Indexed
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-orange-100 text-orange-800 rounded text-xs">
                          Pending
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4 text-sm">{file.chunkCount}</td>
                    <td className="py-3 px-4 text-sm text-gray-500">
                      {file.indexedAt
                        ? new Date(file.indexedAt).toLocaleString()
                        : "-"}
                    </td>
                    <td className="py-3 px-4 text-sm text-gray-500">
                      {file.uploaded.toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filteredFiles.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              No files found matching the selected filters
            </div>
          )}

          {list.truncated && (
            <div className="mt-4 text-sm text-orange-600">
              Note: Showing first 500 files. Some files may not be displayed.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
