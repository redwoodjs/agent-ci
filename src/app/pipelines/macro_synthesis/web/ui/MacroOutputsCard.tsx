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
                <pre className="text-xs bg-gray-50 border-t p-2 overflow-auto max-h-[40vh]">
                  {safeStringify({
                    gating: o.gating,
                    anchors: o.anchors,
                    streams: o.streams,
                    audit: o.audit,
                  })}
                </pre>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
