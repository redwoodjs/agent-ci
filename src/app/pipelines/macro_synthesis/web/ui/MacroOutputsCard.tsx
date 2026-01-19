import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunMacroOutputs } from "@/app/engine/databases/simulationState";

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function MacroOutputsCard({ runId }: { runId: string }) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const outputs = await getSimulationRunMacroOutputs(context, { runId });

  return (
    <Card id="macro-outputs">
      <CardHeader>
        <CardTitle className="text-lg">Macro outputs</CardTitle>
        <CardDescription>
          Per-run macro synthesis outputs (streams + macro moments)
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
                  <div className="text-xs text-gray-600 mt-1">
                    stream_hash={o.microStreamHash.slice(0, 10)}… use_llm=
                    {String(o.useLlm)}
                  </div>
                </div>
                <div className="p-2 space-y-3">
                  {o.streams && o.streams.length > 0 ? (
                    <div className="space-y-4">
                      {o.streams.map((s: any, si: number) => (
                        <div key={si} className="space-y-1.5">
                          <div className="text-xs font-bold text-gray-900 border-b pb-1">
                            Stream: {s.streamId}
                          </div>
                          <div className="space-y-2 pl-2 border-l-2 border-gray-100">
                            {s.macroMoments?.map((m: any, mi: number) => (
                              <div key={mi} className="space-y-1">
                                <div className="text-xs font-semibold text-gray-800">
                                  {m.title}
                                </div>
                                <div className="text-xs text-gray-600 leading-relaxed italic">
                                  {m.summary}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">(no streams produced)</div>
                  )}
                  <details className="mt-4">
                    <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-600">
                      View raw data
                    </summary>
                    <pre className="text-[10px] bg-gray-50 p-2 mt-1 overflow-auto max-h-[20vh] border rounded">
                      {safeStringify({
                        gating: o.gating,
                        anchors: o.anchors,
                        audit: o.audit,
                      })}
                    </pre>
                  </details>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
