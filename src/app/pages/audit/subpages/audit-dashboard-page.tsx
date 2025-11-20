import { env } from "cloudflare:workers";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { getIndexingStatesBatch } from "@/app/engine/db";
import type { RequestInfo } from "rwsdk/worker";

export async function AuditDashboardPage() {
  const bucket = env.MACHINEN_BUCKET;

  // Fetch R2 listings for each source type
  const [discordList, githubList, cursorList] = await Promise.all([
    bucket.list({ prefix: "discord/", limit: 1000 }),
    bucket.list({ prefix: "github/", limit: 1000 }),
    bucket.list({ prefix: "cursor/", limit: 1000 }),
  ]);

  const totalDiscordFiles = discordList.objects.length;
  const totalGithubFiles = githubList.objects.length;
  const totalCursorFiles = cursorList.objects.length;
  const totalFiles = totalDiscordFiles + totalGithubFiles + totalCursorFiles;

  // Get indexing state for all files
  const allKeys = [
    ...discordList.objects.map((obj) => obj.key),
    ...githubList.objects.map((obj) => obj.key),
    ...cursorList.objects.map((obj) => obj.key),
  ];

  const indexingStates = await getIndexingStatesBatch(allKeys);
  const indexedCount = indexingStates.size;
  const pendingCount = totalFiles - indexedCount;

  // Get most recently modified files
  const allObjects = [
    ...discordList.objects,
    ...githubList.objects,
    ...cursorList.objects,
  ];
  const recentFiles = allObjects
    .sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
    .slice(0, 10);

  // Get most recently indexed files
  const indexedEntries = Array.from(indexingStates.entries())
    .sort(
      (a, b) =>
        new Date(b[1].indexed_at).getTime() -
        new Date(a[1].indexed_at).getTime()
    )
    .slice(0, 10);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-bold mb-8">Audit Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Total Files
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">{totalFiles}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Indexed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-green-600">
              {indexedCount}
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
            <div className="text-3xl font-bold text-orange-600">
              {pendingCount}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium text-gray-500">
              Index Coverage
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              {totalFiles > 0
                ? Math.round((indexedCount / totalFiles) * 100)
                : 0}
              %
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Source Breakdown */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Card>
          <CardHeader>
            <CardTitle>Discord</CardTitle>
            <CardDescription>Messages and threads</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalDiscordFiles}</div>
            <div className="text-sm text-gray-500">files in R2</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>GitHub</CardTitle>
            <CardDescription>Issues, PRs, and comments</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalGithubFiles}</div>
            <div className="text-sm text-gray-500">files in R2</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cursor</CardTitle>
            <CardDescription>Conversations</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalCursorFiles}</div>
            <div className="text-sm text-gray-500">files in R2</div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card>
          <CardHeader>
            <CardTitle>Recently Modified Files</CardTitle>
            <CardDescription>Last 10 files updated in R2</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentFiles.map((file) => (
                <div
                  key={file.key}
                  className="flex justify-between items-start p-2 hover:bg-gray-50 rounded"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {file.key}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatBytes(file.size)}
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 ml-2 whitespace-nowrap">
                    {formatDate(file.uploaded)}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recently Indexed</CardTitle>
            <CardDescription>Last 10 files indexed into RAG</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {indexedEntries.map(([key, state]) => (
                <div
                  key={key}
                  className="flex justify-between items-start p-2 hover:bg-gray-50 rounded"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{key}</div>
                    <div className="text-xs text-gray-500">
                      {state.chunk_ids?.length || 0} chunks
                    </div>
                  </div>
                  <div className="text-xs text-gray-500 ml-2 whitespace-nowrap">
                    {formatDate(new Date(state.indexed_at))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
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

function formatDate(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) {
    return date.toLocaleDateString();
  } else if (days > 0) {
    return `${days}d ago`;
  } else if (hours > 0) {
    return `${hours}h ago`;
  } else if (minutes > 0) {
    return `${minutes}m ago`;
  } else {
    return "just now";
  }
}
