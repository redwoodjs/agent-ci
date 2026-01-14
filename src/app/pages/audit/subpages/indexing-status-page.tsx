import { Suspense } from "react";
import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/app/components/ui/card";
import { getIndexingStatesBatch } from "@/app/engine/databases/indexingState";
import { IndexingTable } from "./indexing-table";
import { getMomentGraphNamespacePrefixFromEnv } from "@/app/engine/momentGraphNamespace";

export function IndexingStatusPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const source = url.searchParams.get("source") || "all";
  const statusFilter = url.searchParams.get("status") || "all";

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Indexing Status</h1>

      <Suspense
        fallback={
          <>
            <StatsCardsSkeleton />
            <FilesTableSkeleton />
          </>
        }
      >
        <IndexingContent source={source} statusFilter={statusFilter} />
      </Suspense>
    </div>
  );
}

async function IndexingContent({
  source,
  statusFilter,
}: {
  source: string;
  statusFilter: string;
}) {
  const bucket = env.MACHINEN_BUCKET;

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

  // Get indexing states once
  const indexingStates = await getIndexingStatesBatch(allKeys, {
    env,
    momentGraphNamespace: null,
  });

  // Build combined view once
  const files = list.objects.map((obj) => {
    const indexingState = indexingStates.get(obj.key);

    // Check if file is a valid indexable file
    // Old Discord thread files with pattern YYYY-MM-DD-thread-ID.jsonl are invalid
    const isValid = !(
      obj.key.startsWith("discord/") &&
      obj.key.endsWith(".jsonl") &&
      obj.key.includes("-thread-")
    );

    return {
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded,
      etag: obj.etag,
      indexed: !!indexingState,
      indexedAt: indexingState?.indexed_at,
      indexedEtag: indexingState?.etag,
      chunkCount: indexingState?.chunk_count || 0,
      needsReindex: indexingState ? indexingState.etag !== obj.etag : false,
      isValid,
    };
  });

  const stats = {
    total: files.length,
    indexed: files.filter((f) => f.indexed && !f.needsReindex).length,
    pending: files.filter((f) => !f.indexed).length,
    stale: files.filter((f) => f.needsReindex).length,
    invalid: files.filter((f) => !f.isValid).length,
  };

  // Filter by status
  const filteredFiles = files.filter((file) => {
    if (statusFilter === "indexed") return file.indexed && !file.needsReindex;
    if (statusFilter === "pending") return !file.indexed;
    if (statusFilter === "stale") return file.needsReindex;
    if (statusFilter === "invalid") return !file.isValid;
    return true;
  });

  const namespacePrefix = getMomentGraphNamespacePrefixFromEnv(env);

  return (
    <>
      <SystemContext prefix={namespacePrefix} />
      <StatsCards stats={stats} />
      <Filters source={source} statusFilter={statusFilter} />
      <FilesTable files={filteredFiles} listTruncated={list.truncated} />
    </>
  );
}

function SystemContext({ prefix }: { prefix: string | null }) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>System Context</CardTitle>
        <CardDescription>
          Current namespace prefix configuration
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="p-3 bg-gray-50 rounded border font-mono text-sm">
          {prefix ? (
            <span className="text-blue-600">{prefix}</span>
          ) : (
            <span className="text-gray-400">Not set</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-2">
          This prefix is automatically applied to all namespace queries. Data is
          stored in namespaced Durable Objects.
        </p>
      </CardContent>
    </Card>
  );
}

function StatsCards({
  stats,
}: {
  stats: {
    total: number;
    indexed: number;
    pending: number;
    stale: number;
    invalid: number;
  };
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-8">
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

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium text-gray-500">
            Invalid
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold text-gray-600">
            {stats.invalid}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Filters({
  source,
  statusFilter,
}: {
  source: string;
  statusFilter: string;
}) {
  return (
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
        <a
          href={`/audit/indexing?source=${source}&status=invalid`}
          className={`px-3 py-1 text-sm rounded ${
            statusFilter === "invalid"
              ? "bg-gray-600 text-white"
              : "bg-gray-200 text-gray-700 hover:bg-gray-300"
          }`}
        >
          Invalid
        </a>
      </div>
    </div>
  );
}

function FilesTable({
  files,
  listTruncated,
}: {
  files: Array<{
    key: string;
    size: number;
    uploaded: Date;
    etag: string;
    indexed: boolean;
    indexedAt?: string;
    indexedEtag?: string;
    chunkCount: number;
    needsReindex: boolean;
    isValid: boolean;
  }>;
  listTruncated: boolean;
}) {
  return (
    <Card>
      <CardContent>
        <IndexingTable files={files} />

        {files.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            No files found matching the selected filters
          </div>
        )}

        {listTruncated && (
          <div className="mt-4 text-sm text-orange-600">
            Note: Showing first 500 files. Some files may not be displayed.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatsCardsSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
      {[1, 2, 3, 4].map((i) => (
        <Card key={i}>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              <div className="h-4 w-24 bg-gray-200 rounded animate-pulse" />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-8 w-16 bg-gray-200 rounded animate-pulse" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FilesTableSkeleton() {
  return (
    <Card>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b">
              <tr>
                {[1, 2, 3, 4, 5, 6, 7].map((i) => (
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
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="border-b">
                  {[1, 2, 3, 4, 5, 6, 7].map((j) => (
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
