import { env } from "cloudflare:workers";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import { getSimulationRunMaterializedMoments } from "@/app/engine/databases/simulationState";

export async function MaterializedMomentsCard({
  runId,
  effectiveNamespace,
}: {
  runId: string;
  effectiveNamespace: string | null;
}) {
  const envCloudflare = env as Cloudflare.Env;
  const context = { env: envCloudflare, momentGraphNamespace: null as any };
  const moments = await getSimulationRunMaterializedMoments(context, { runId });

  return (
    <Card id="materialized-moments">
      <CardHeader>
        <CardTitle className="text-lg">Materialized moments</CardTitle>
        <CardDescription>
          Per-run materialized moments mapping. Namespace:{" "}
          <span className="font-mono">{effectiveNamespace}</span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {moments.length === 0 ? (
          <div className="text-sm text-gray-600">(none)</div>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-gray-600">
              Note: these are the mapping rows in simulation DB, pointing to
              actual moments in the moment graph.
            </div>
            <div className="space-y-2">
              {moments.slice(0, 200).map((m) => (
                <div
                  key={m.momentId}
                  className="p-3 rounded border bg-white shadow-sm flex flex-col gap-2"
                >
                  <div className="flex justify-between items-start gap-2">
                    <div className="font-semibold text-sm text-gray-900 group-hover:text-blue-600 transition-colors">
                      {m.title || "(Untitled)"}
                    </div>
                    <div className="text-[10px] font-mono text-gray-400 bg-gray-50 px-1 rounded border border-gray-100 whitespace-nowrap">
                      {m.momentId.slice(0, 8)}...
                    </div>
                  </div>

                  {m.summary ? (
                    <div className="text-xs text-gray-600 leading-relaxed italic">
                      {m.summary}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 italic">No summary available</div>
                  )}

                  {(m as any).subjectReason && (
                    <div className="mt-2 p-2 bg-blue-50/50 border border-blue-100 rounded text-xs text-blue-900">
                      <div className="font-semibold text-[10px] uppercase tracking-wider text-blue-600 mb-1">
                        Subject Reason
                      </div>
                      <div className="leading-relaxed">{(m as any).subjectReason}</div>
                    </div>
                  )}

                  <div className="pt-2 border-t border-gray-50 mt-1">
                    <div className="font-mono text-[10px] text-gray-500 truncate" title={m.r2Key}>
                      Key: {m.r2Key}
                    </div>
                    <div className="text-[10px] text-gray-400 flex gap-2 mt-1">
                      <span>Stream: <span className="text-gray-600 font-medium">{m.streamId}</span></span>
                      <span>Idx: <span className="text-gray-600 font-medium">{m.macroIndex}</span></span>
                      {m.parentId && (
                        <span>Parent: <span className="text-gray-600 font-medium">{m.parentId.slice(0, 8)}</span></span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {moments.length > 200 ? (
                <div className="text-xs text-gray-600">
                  Showing first 200 of {moments.length}
                </div>
              ) : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
