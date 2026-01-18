import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunMicroBatches } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function MicroBatchesCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const batches = await getSimulationRunMicroBatches(context, { runId });

  return (
    <Card id="micro-batches">
      <CardHeader>
        <CardTitle className="text-lg">Micro batches</CardTitle>
        <CardDescription>Per-run micro batch mapping</CardDescription>
      </CardHeader>
      <CardContent>
        {batches.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {batches.slice(0, 200).map((b) => (
              <div
                key={`${b.r2Key}:${b.batchIndex}`}
                className="flex items-start justify-between gap-4 p-2 rounded border bg-white"
              >
                <div className="min-w-0">
                  <div className="font-mono text-xs break-all">{b.r2Key}</div>
                  <div className="text-xs text-gray-600 mt-1">
                    idx={String(b.batchIndex)} status={b.status} hash=
                    {b.batchHash.slice(0, 10)}…
                  </div>
                  {b.error ? (
                    <div className="text-xs text-red-700 mt-1">
                      {safeStringify(b.error)}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {batches.length > 200 ? (
              <div className="text-xs text-gray-600">
                Showing first 200 of {batches.length}
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
