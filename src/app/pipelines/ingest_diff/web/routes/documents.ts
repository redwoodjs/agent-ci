import { route } from "rwsdk/router";
import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { requireQueryApiKey } from "@/app/engine/interruptors";
import { getSimulationRunDocuments } from "@/app/engine/databases/simulationState";


export async function getSimulationRunDocumentsHandler({ params }: RequestInfo) {
  const runIdRaw = (params as any)?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const documents = await getSimulationRunDocuments(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );

  return Response.json({ documents });
}

export const ingestDiffRoutes = [
  route("/admin/simulation/run/:runId/documents", {
    get: [requireQueryApiKey, getSimulationRunDocumentsHandler],
  }),
];
