import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { requireQueryApiKey } from "@/app/engine/interruptors";
import { getSimulationRunTimelineFitDecisions } from "@/app/engine/databases/simulationState";


export async function getSimulationRunTimelineFitDecisionsHandler({
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

  const decisions = await getSimulationRunTimelineFitDecisions(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, r2Key }
  );

  return Response.json({ decisions });
}

export const timelineFitRoutes = [
  route("/admin/simulation/run/:runId/timeline-fit-decisions", {
    get: [requireQueryApiKey, getSimulationRunTimelineFitDecisionsHandler],
  }),
];
