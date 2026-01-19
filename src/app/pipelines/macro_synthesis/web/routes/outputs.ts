import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { requireQueryApiKey } from "@/app/engine/interruptors";
import { getSimulationRunMacroOutputs } from "@/app/engine/databases/simulationState";


export async function getSimulationRunMacroOutputsHandler({
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

  const outputs = await getSimulationRunMacroOutputs(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, r2Key }
  );

  return Response.json({ outputs });
}

export const macroSynthesisRoutes = [
  route("/admin/simulation/run/:runId/macro-outputs", {
    get: [requireQueryApiKey, getSimulationRunMacroOutputsHandler],
  }),
];
