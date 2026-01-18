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
                className="p-3 rounded border bg-white shadow-sm flex flex-col gap-3"
              >
                <div className="space-y-1">
                  <div className="flex justify-between items-start gap-2">
                    <div className="font-semibold text-sm text-gray-900">
                      {d.childTitle || "(Untitled Child)"}
                    </div>
                    <div className="text-[10px] font-mono text-gray-400 bg-gray-50 px-1 rounded border border-gray-100 whitespace-nowrap">
                      {d.childMomentId.slice(0, 8)}...
                    </div>
                  </div>
                  {d.childSummary && (
                    <div className="text-xs text-gray-600 leading-relaxed italic">
                      {d.childSummary}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 py-1">
                  <div className="h-px flex-1 bg-gray-100" />
                  <div className={`px-2 py-0.5 rounded-full text-[10px] uppercase font-bold tracking-wider border ${
                    d.parentMomentId ? "bg-green-50 text-green-700 border-green-100" : "bg-gray-50 text-gray-400 border-gray-200"
                  }`}>
                    {d.parentMomentId ? "Linked" : "No Match"}
                  </div>
                  <div className="h-px flex-1 bg-gray-100" />
                </div>

                {d.parentMomentId ? (
                  <div className="space-y-1 bg-green-50/30 p-2 rounded border border-green-100/50">
                    <div className="flex justify-between items-start gap-2">
                      <div className="font-semibold text-xs text-green-900">
                        {d.parentTitle || "(Untitled Parent)"}
                      </div>
                      <div className="text-[10px] font-mono text-green-400 whitespace-nowrap">
                        {d.parentMomentId.slice(0, 8)}...
                      </div>
                    </div>
                    {d.parentSummary && (
                      <div className="text-[11px] text-green-800/80 leading-snug italic">
                        {d.parentSummary}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-[10px] text-gray-500 italic text-center py-1">
                    No deterministic match found for this moment.
                  </div>
                )}

                <details className="mt-1">
                  <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600 font-semibold uppercase tracking-tight">
                    Link Evidence
                  </summary>
                  <pre className="mt-1 text-[10px] bg-gray-50 border p-2 rounded overflow-auto max-h-[30vh] font-mono text-gray-600">
                    {safeStringify(d.evidence)}
                  </pre>
                </details>
              </div>
            ))}
          </div>
        )}

      </CardContent>
    </Card>
  );
}
