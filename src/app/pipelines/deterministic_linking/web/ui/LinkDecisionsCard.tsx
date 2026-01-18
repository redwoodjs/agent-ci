import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunLinkDecisions } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function LinkDecisionsCard({
  runId,
  effectiveNamespace,
}: {
  runId: string;
  effectiveNamespace: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const decisions = await getSimulationRunLinkDecisions(context, { runId });

  return (
    <Card id="link-decisions">
      <CardHeader>
        <CardTitle className="text-lg">Link decisions</CardTitle>
        <CardDescription>
          Per-run link decisions (deterministic). Namespace:{" "}
          <span className="font-mono">{effectiveNamespace}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {decisions.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {decisions.map((d) => (
              <div
                key={d.childMomentId}
                className="p-2 rounded border bg-white flex flex-col gap-1"
              >
                <div className="text-[10px] font-mono text-gray-400 break-all">
                  {d.childMomentId}
                </div>
                <div className="text-xs font-semibold">
                  {d.parentMomentId ? (
                    <span className="text-green-700">
                      Linked to: {d.parentMomentId}
                    </span>
                  ) : (
                    <span className="text-gray-500 text-[10px]">No parent</span>
                  )}
                </div>

                <pre className="text-[10px] bg-gray-50 border p-1 overflow-auto max-h-[20vh]">
                  {safeStringify(d.evidence)}
                </pre>
              </div>
            ))}
          </div>
        )}

      </CardContent>
    </Card>
  );
}
