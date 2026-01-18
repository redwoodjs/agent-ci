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
                className="p-2 rounded border bg-white flex flex-col gap-1"
              >
                <div className="text-[10px] font-mono text-gray-400 break-all">
                  {s.childMomentId}
                </div>

                <div className="text-xs font-semibold">
                  Candidates: {s.candidates ? s.candidates.length : 0}
                </div>
                <pre className="text-[10px] bg-gray-50 border p-1 overflow-auto max-h-[20vh]">
                  {safeStringify({
                    candidates: s.candidates,
                    stats: s.stats,
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
