import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunTimelineFitDecisions } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function TimelineFitDecisionsCard({
  runId,
  effectiveNamespace,
}: {
  runId: string;
  effectiveNamespace: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const decisions = await getSimulationRunTimelineFitDecisions(context, {
    runId,
  });

  return (
    <Card id="timeline-fit-decisions">
      <CardHeader>
        <CardTitle className="text-lg">Timeline fit decisions</CardTitle>
        <CardDescription>
          Per-run timeline fit decisions (model-backed). Namespace:{" "}
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
                    (d.outcome === "fit" || d.outcome === "attached") ? "bg-green-50 text-green-700 border-green-100" : "bg-red-50 text-red-700 border-red-100"
                  }`}>
                    {(d.outcome === "fit" || d.outcome === "attached") ? "Fit to Timeline" : "Rejected / No Fit"}
                  </div>
                  <div className="h-px flex-1 bg-gray-100" />
                </div>

                {d.chosenParentMomentId && (
                  <div className="space-y-1 bg-blue-50/30 p-2 rounded border border-blue-100/50">
                    <div className="text-[9px] font-bold text-blue-400 uppercase tracking-tight">Chosen Parent</div>
                    <div className="flex justify-between items-start gap-2">
                      <div className="font-semibold text-xs text-blue-900">
                        {d.chosenParentTitle || "(Untitled Parent)"}
                      </div>
                      <div className="text-[10px] font-mono text-blue-400 whitespace-nowrap">
                        {d.chosenParentMomentId.slice(0, 8)}...
                      </div>
                    </div>
                    {d.chosenParentSummary && (
                      <div className="text-[11px] text-blue-800/80 leading-snug italic">
                        {d.chosenParentSummary}
                      </div>
                    )}
                  </div>
                )}

                <details className="mt-1">
                  <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600 font-semibold uppercase tracking-tight">
                    Model Reasoning & Stats
                  </summary>
                  <pre className="mt-1 text-[10px] bg-gray-50 border p-2 rounded overflow-auto max-h-[30vh] font-mono text-gray-600">
                    {safeStringify({
                      decisions: d.decisions,
                      stats: d.stats,
                    })}
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
