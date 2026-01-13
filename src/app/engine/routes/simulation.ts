import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { requireQueryApiKey } from "../interruptors";
import {
  advanceSimulationRunPhaseNoop,
  createSimulationRun,
  getSimulationRunById,
  getSimulationRunDocuments,
  getSimulationRunEvents,
  getSimulationRunMacroOutputs,
  getSimulationRunMaterializedMoments,
  getSimulationRunMicroBatches,
  getSimulationRunLinkDecisions,
  pauseSimulationRunManual,
  restartSimulationRunFromPhase,
  resumeSimulationRun,
  simulationPhases,
} from "../simulationDb";

async function startSimulationRunHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: any = undefined;
  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const namespaceRaw = body?.momentGraphNamespace ?? body?.namespace;
  const momentGraphNamespace =
    typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
      ? namespaceRaw.trim()
      : null;

  const namespacePrefixRaw =
    body?.momentGraphNamespacePrefix ?? body?.namespacePrefix;
  const momentGraphNamespacePrefix =
    typeof namespacePrefixRaw === "string" && namespacePrefixRaw.trim().length > 0
      ? namespacePrefixRaw.trim()
      : null;

  const runId = crypto.randomUUID();
  const effectiveMomentGraphNamespace = momentGraphNamespace ?? `sim-${runId}`;

  await createSimulationRun(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    {
      runId,
      momentGraphNamespace: effectiveMomentGraphNamespace,
      momentGraphNamespacePrefix,
      config:
        body && typeof body === "object"
          ? { ...body, createdFrom: "admin.start" }
          : { createdFrom: "admin.start" },
    }
  );

  return Response.json({ runId });
}

async function advanceSimulationRunHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: any = undefined;
  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const runIdRaw = body?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const updated = await advanceSimulationRunPhaseNoop(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!updated) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json(updated);
}

async function getSimulationRunHandler({ params }: RequestInfo) {
  const runIdRaw = (params as any)?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const run = await getSimulationRunById(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!run) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json(run);
}

async function getSimulationRunEventsHandler({ params, request }: RequestInfo) {
  const runIdRaw = (params as any)?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const url = new URL(request.url);
  const limitRaw = url.searchParams.get("limit");
  const limit =
    typeof limitRaw === "string" && limitRaw.trim().length > 0
      ? Number(limitRaw)
      : undefined;

  const events = await getSimulationRunEvents(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, limit }
  );

  return Response.json({ events });
}

async function getSimulationRunDocumentsHandler({ params }: RequestInfo) {
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

async function getSimulationRunMicroBatchesHandler({
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

  const batches = await getSimulationRunMicroBatches(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, r2Key }
  );

  return Response.json({ batches });
}

async function getSimulationRunMacroOutputsHandler({
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

async function getSimulationRunMaterializedMomentsHandler({
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

async function getSimulationRunLinkDecisionsHandler({
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

  const decisions = await getSimulationRunLinkDecisions(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, r2Key }
  );

  return Response.json({ decisions });
}

async function pauseSimulationRunHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: any = undefined;
  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const runIdRaw = body?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const ok = await pauseSimulationRunManual(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!ok) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}

async function resumeSimulationRunHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: any = undefined;
  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const runIdRaw = body?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const ok = await resumeSimulationRun(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId }
  );
  if (!ok) {
    return Response.json({ error: "Run not found" }, { status: 404 });
  }

  return Response.json({ success: true });
}

async function restartSimulationRunHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: any = undefined;
  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const runIdRaw = body?.runId;
  const runId = typeof runIdRaw === "string" ? runIdRaw.trim() : "";
  if (!runId) {
    return Response.json({ error: "Missing runId" }, { status: 400 });
  }

  const phaseRaw = body?.phase;
  const phase =
    typeof phaseRaw === "string" && simulationPhases.includes(phaseRaw as any)
      ? (phaseRaw as any)
      : simulationPhases[0];

  const ok = await restartSimulationRunFromPhase(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, phase }
  );
  if (!ok) {
    return Response.json(
      { error: "Run not found or invalid phase" },
      { status: 404 }
    );
  }

  return Response.json({ success: true, phase });
}

export const simulationAdminRoutes = [
  route("/admin/simulation/run/start", {
    post: [requireQueryApiKey, startSimulationRunHandler],
  }),
  route("/admin/simulation/run/advance", {
    post: [requireQueryApiKey, advanceSimulationRunHandler],
  }),
  route("/admin/simulation/run/pause", {
    post: [requireQueryApiKey, pauseSimulationRunHandler],
  }),
  route("/admin/simulation/run/resume", {
    post: [requireQueryApiKey, resumeSimulationRunHandler],
  }),
  route("/admin/simulation/run/restart", {
    post: [requireQueryApiKey, restartSimulationRunHandler],
  }),
  route("/admin/simulation/run/:runId", {
    get: [requireQueryApiKey, getSimulationRunHandler],
  }),
  route("/admin/simulation/run/:runId/documents", {
    get: [requireQueryApiKey, getSimulationRunDocumentsHandler],
  }),
  route("/admin/simulation/run/:runId/micro-batches", {
    get: [requireQueryApiKey, getSimulationRunMicroBatchesHandler],
  }),
  route("/admin/simulation/run/:runId/macro-outputs", {
    get: [requireQueryApiKey, getSimulationRunMacroOutputsHandler],
  }),
  route("/admin/simulation/run/:runId/materialized-moments", {
    get: [requireQueryApiKey, getSimulationRunMaterializedMomentsHandler],
  }),
  route("/admin/simulation/run/:runId/link-decisions", {
    get: [requireQueryApiKey, getSimulationRunLinkDecisionsHandler],
  }),
  route("/admin/simulation/run/:runId/events", {
    get: [requireQueryApiKey, getSimulationRunEventsHandler],
  }),
];

