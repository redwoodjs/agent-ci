import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { requireQueryApiKey } from "@/app/engine/interruptors";
import { getSimulationRunMaterializedMoments } from "@/app/engine/databases/simulationState";


export async function getSimulationRunMaterializedMomentsHandler({
  params,
  request,
}: RequestInfo) {
  const runIdRaw = (params as any)?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const r2KeyRaw = url.searchParams.get("r2Key");
  const r2Key =
    typeof r2KeyRaw === "string" && r2KeyRaw.trim().length > 0
      ? r2KeyRaw.trim()
      : null;

  const moments = await getSimulationRunMaterializedMoments(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, r2Key }
  );

  return Response.json({ moments });
}

export const materializeMomentsRoutes = [
  route("/admin/simulation/run/:runId/materialized-moments", {
    get: [requireQueryApiKey, getSimulationRunMaterializedMomentsHandler],
  }),
];
