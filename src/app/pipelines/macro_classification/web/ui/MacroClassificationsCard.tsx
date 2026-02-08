import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunMacroClassifiedOutputs } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function MacroClassificationsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const outputs = await getSimulationRunMacroClassifiedOutputs(context, {
    runId,
  });

  return (
    <Card id="macro-classifications">
      <CardHeader>
        <CardTitle className="text-lg">Macro classifications</CardTitle>
        <CardDescription>
          Per-run macro gating + classification outputs (ready for
          materialization)
        </CardDescription>
      </CardHeader>
      <CardContent>
        {outputs.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-2">
            {outputs.map((o) => (
              <div key={o.r2Key} className="rounded border bg-white">
                <div className="p-2">
                  <div className="font-mono text-xs break-all">{o.r2Key}</div>
                </div>
                <div className="border-t">
                  <div className="p-3 space-y-4">
                    {Array.isArray((o as any).classifications) && (o as any).classifications.length > 0 ? (
                      (o as any).classifications.map((c: any, idx: number) => {
                        const moment = o.streams?.flatMap((s: any) => s.macroMoments).find((m: any, mIdx: number) => mIdx + 1 === c.index);
                        return (
                          <div key={idx} className="space-y-2 border-b pb-4 last:border-0 last:pb-0">
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-bold bg-gray-100 px-1.5 py-0.5 rounded uppercase tracking-tighter">
                                  {c.momentKind || "unknown"}
                                </span>
                                {c.isSubject && (
                                  <span className="text-[10px] font-bold bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded uppercase tracking-tighter">
                                    Subject
                                  </span>
                                )}
                              </div>
                              <span className={`text-[10px] font-medium ${c.confidence === 'high' ? 'text-green-600' : c.confidence === 'medium' ? 'text-yellow-600' : 'text-red-500'}`}>
                                Confidence: {c.confidence}
                              </span>
                            </div>
                            
                            <div className="text-sm font-semibold text-gray-900 leading-tight">
                              {moment?.title || `Moment ${c.index}`}
                            </div>

                            {c.isSubject && c.subjectReason && (
                              <div className="p-2 bg-blue-50 border border-blue-100 rounded text-xs text-blue-900">
                                <div className="font-semibold text-[10px] uppercase tracking-wider text-blue-600 mb-0.5">
                                  Subject Justification
                                </div>
                                {c.subjectReason}
                              </div>
                            )}

                            {Array.isArray(c.momentEvidence) && c.momentEvidence.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {c.momentEvidence.map((e: string, eIdx: number) => (
                                  <span key={eIdx} className="text-[9px] bg-gray-50 text-gray-500 border rounded px-1 py-0.5">
                                    "{e}"
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })
                    ) : (
                      <div className="text-xs text-gray-400 italic">No classifications available</div>
                    )}
                  </div>
                </div>
                <details className="border-t bg-gray-50">
                  <summary className="text-[10px] text-gray-500 p-2 cursor-pointer hover:bg-gray-100 select-none">
                    View Raw Artifact
                  </summary>
                  <pre className="text-[10px] p-2 overflow-auto max-h-[40vh] border-t">
                    {safeStringify({
                      gating: o.gating,
                      classification: (o as any).classifications,
                      streams: o.streams,
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
