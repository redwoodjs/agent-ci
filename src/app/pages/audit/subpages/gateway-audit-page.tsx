import { Suspense } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardDescription,
} from "@/app/components/ui/card";
import { getGatewayAuditLog } from "./actions";
import type { GatewayAuditEntry } from "@/app/ingestors/discord/db/gateway-audit-types";

export function GatewayAuditPage({ request }: { request: Request }) {
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(Number(limitParam), 1), 500) : 200;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Discord Gateway Audit Log</h1>
        <div className="flex gap-2">
          <a
            href="/audit/gateway?limit=100"
            className={`px-4 py-2 rounded ${
              limit === 100
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            100
          </a>
          <a
            href="/audit/gateway?limit=200"
            className={`px-4 py-2 rounded ${
              limit === 200
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            200
          </a>
          <a
            href="/audit/gateway?limit=500"
            className={`px-4 py-2 rounded ${
              limit === 500
                ? "bg-blue-600 text-white"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            500
          </a>
        </div>
      </div>

      <Suspense fallback={<AuditTableSkeleton />}>
        <AuditTable limit={limit} />
      </Suspense>
    </div>
  );
}

async function AuditTable({ limit }: { limit: number }) {
  const result = await getGatewayAuditLog(limit);

  if (!result.success) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center text-red-600">
            Error: {result.error}
          </div>
        </CardContent>
      </Card>
    );
  }

  const entries = result.entries;

  if (entries.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Gateway Audit Log</CardTitle>
          <CardDescription>No audit entries found</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Gateway Audit Log</CardTitle>
        <CardDescription>
          Showing {entries.length} most recent entries
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b">
              <tr>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Timestamp
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Kind
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Event Type
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Status
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  R2 Key
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Guild/Channel/Thread
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Sequence
                </th>
                <th className="text-left py-3 px-4 font-medium text-sm text-gray-500">
                  Error
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, idx) => (
                <tr
                  key={`${entry.ts}-${idx}`}
                  className="border-b hover:bg-gray-50"
                >
                  <td className="py-3 px-4 text-sm">
                    {formatTimestamp(entry.ts)}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        entry.kind === "dispatch"
                          ? "bg-blue-100 text-blue-800"
                          : entry.kind === "gateway"
                          ? "bg-green-100 text-green-800"
                          : "bg-red-100 text-red-800"
                      }`}
                    >
                      {entry.kind}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm font-mono text-xs">
                    {entry.eventType || "-"}
                  </td>
                  <td className="py-3 px-4 text-sm">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${
                        entry.status === "handled"
                          ? "bg-green-100 text-green-800"
                          : entry.status === "failed"
                          ? "bg-red-100 text-red-800"
                          : entry.status === "forwarding"
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {entry.status || "-"}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-sm font-mono text-xs max-w-xs truncate">
                    {entry.r2Key ? (
                      <span className="text-blue-600" title={entry.r2Key}>
                        {entry.r2Key}
                      </span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm font-mono text-xs">
                    {entry.guildId || entry.channelId || entry.threadId ? (
                      <div className="space-y-1">
                        {entry.guildId && (
                          <div>
                            <span className="text-gray-500">G:</span>{" "}
                            {entry.guildId.substring(0, 8)}...
                          </div>
                        )}
                        {entry.channelId && (
                          <div>
                            <span className="text-gray-500">C:</span>{" "}
                            {entry.channelId.substring(0, 8)}...
                          </div>
                        )}
                        {entry.threadId && (
                          <div>
                            <span className="text-gray-500">T:</span>{" "}
                            {entry.threadId.substring(0, 8)}...
                          </div>
                        )}
                      </div>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm font-mono text-xs">
                    {entry.sequence !== null && entry.sequence !== undefined
                      ? entry.sequence
                      : "-"}
                  </td>
                  <td className="py-3 px-4 text-sm text-red-600 max-w-xs truncate">
                    {entry.error || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditTableSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <div className="h-6 w-48 bg-gray-200 rounded animate-pulse" />
        </CardTitle>
        <CardDescription>
          <div className="h-4 w-32 bg-gray-200 rounded animate-pulse mt-2" />
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b">
              <tr>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
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
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((j) => (
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

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ago`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ago`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s ago`;
  } else {
    return `${seconds}s ago`;
  }
}

