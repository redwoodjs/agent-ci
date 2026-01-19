import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunCandidateSets } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function CandidateSetsCard({
  runId,
  effectiveNamespace,
}: {
  runId: string;
  effectiveNamespace: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const sets = await getSimulationRunCandidateSets(context, { runId });

  return (
    <Card id="candidate-sets">
      <CardHeader>
        <CardTitle className="text-lg">Candidate sets</CardTitle>
        <CardDescription>
          Per-run candidate sets (vector + anchor matches). Namespace:{" "}
          <span className="font-mono">{effectiveNamespace}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sets.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {sets.map((s) => (
              <div
                key={s.childMomentId}
                className="p-3 rounded border bg-white shadow-sm flex flex-col gap-3"
              >
                <div className="space-y-1">
                  <div className="flex justify-between items-start gap-2">
                    <div className="font-semibold text-sm text-gray-900">
                      {s.childTitle || "(Untitled Child)"}
                    </div>
                    <div className="text-[10px] font-mono text-gray-400 bg-gray-50 px-1 rounded border border-gray-100 whitespace-nowrap">
                      {s.childMomentId.slice(0, 8)}...
                    </div>
                  </div>
                  {s.childSummary && (
                    <div className="text-xs text-gray-600 leading-relaxed italic">
                      {s.childSummary}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    Candidates ({s.candidates.length})
                  </div>
                  <div className="space-y-2">
                    {s.candidates.length === 0 ? (
                      <div className="text-[10px] text-gray-400 italic px-2">No candidates found.</div>
                    ) : (
                      s.candidates.slice(0, 5).map((c, i) => (
                        <div key={c.momentId || i} className="bg-gray-50/50 p-2 rounded border border-gray-100 text-[11px]">
                          <div className="flex justify-between items-start gap-2">
                            <div className="font-medium text-gray-800">
                              {c.title || "(Untitled Candidate)"}
                            </div>
                            <div className="font-mono text-[9px] text-gray-400">
                              {c.momentId ? c.momentId.slice(0, 8) : "N/A"}
                            </div>
                          </div>
                          {c.summary && (
                            <div className="text-gray-500 italic mt-0.5 line-clamp-2">
                              {c.summary}
                            </div>
                          )}
                          <div className="text-[9px] text-gray-400 mt-1 flex gap-2">
                            {c.score != null && <span>Score: {(Number(c.score) * 100).toFixed(1)}%</span>}
                            {c.reason && <span className="truncate">Reason: {c.reason}</span>}
                          </div>
                        </div>
                      ))
                    )}
                    {s.candidates.length > 5 && (
                      <div className="text-[9px] text-gray-400 text-center italic">
                        + {s.candidates.length - 5} more candidates
                      </div>
                    )}
                  </div>
                </div>

                <details className="mt-1">
                  <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600 font-semibold uppercase tracking-tight">
                    Candidate Debug Info
                  </summary>
                  <pre className="mt-1 text-[10px] bg-gray-50 border p-2 rounded overflow-auto max-h-[30vh] font-mono text-gray-600">
                    {safeStringify({
                      candidates: s.candidates,
                      stats: s.stats,
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
