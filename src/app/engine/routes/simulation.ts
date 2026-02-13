import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { requireQueryApiKey } from "../interruptors";
import { getSimulationDb } from "../simulation/db";
import { simulationPipelineRoutes } from "../../pipelines/registry";
import {
  tickSimulationRun,
  createSimulationRun,
  getSimulationRunById,
  getSimulationRunEvents,
  pauseSimulationRunManual,
  restartSimulationRunFromPhase,
  resumeSimulationRun,
  simulationPhases,
} from "../databases/simulationState";


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
    typeof namespacePrefixRaw === "string" &&
    namespacePrefixRaw.trim().length > 0
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

  const updated = await tickSimulationRun(
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

  const sortRaw = url.searchParams.get("sort");
  const sort = sortRaw === "asc" ? "asc" : "desc";

  const events = await getSimulationRunEvents(
    { env: env as Cloudflare.Env, momentGraphNamespace: null },
    { runId, limit, sort }
  );

  return Response.json({ events });
}

// Basic handlers like start/advance/pause/etc stay here, but artifact handlers are moved to pipelines


// Macro/Materialize/Linking/Candidate/Timeline handlers moved to pipelines


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
  route("/admin/simulation/run/:runId/events", {
    get: [requireQueryApiKey, getSimulationRunEventsHandler],
  }),

  route("/admin/simulation/run/:runId", {
    get: [requireQueryApiKey, getSimulationRunHandler],
  }),
  ...simulationPipelineRoutes,
];
