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
                  className="p-2 rounded border bg-white flex flex-col gap-1"
                >
                  <div className="text-[10px] font-mono text-gray-400 break-all">
                    {m.momentId}
                  </div>
                  <div className="font-mono text-xs break-all">{m.r2Key}</div>
                  <div className="text-[10px] text-gray-500">
                    momentId={m.momentId} streamId={m.streamId} idx=
                    {String(m.macroIndex)}
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
