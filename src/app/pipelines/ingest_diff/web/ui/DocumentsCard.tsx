import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunDocuments } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function DocumentsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const docs = await getSimulationRunDocuments(context, { runId });

  return (
    <Card id="documents">
      <CardHeader>
        <CardTitle className="text-lg">Documents</CardTitle>
        <CardDescription>Per-run diff results</CardDescription>
      </CardHeader>
      <CardContent>
        {docs.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div
                key={d.r2Key}
                className="flex items-start justify-between gap-4 p-2 rounded border bg-white"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs break-all">{d.r2Key}</div>
                  <div className="text-xs text-gray-600 mt-1">
                    changed={String(d.changed)} etag={d.etag ?? "null"}
                  </div>
                  {d.error ? (
                    <div className="text-xs text-red-700 mt-1">
                      {safeStringify(d.error)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
