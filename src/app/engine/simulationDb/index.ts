import { type Database, createDb } from "rwsdk/db";
import type { EngineSimulationStateDO } from "./durableObject";
import { simulationStateMigrations } from "./migrations";
import { qualifyName } from "../momentGraphNamespace";
import { Override } from "@/app/shared/kyselyTypeOverrides";

type SimulationDatabase = Database<typeof simulationStateMigrations>;

type SimulationRunInput = SimulationDatabase["simulation_runs"];
type SimulationRunRow = Override<
  SimulationRunInput,
  {
    config_json: any;
    last_error_json: any;
  }
>;

type SimulationRunEventInput = SimulationDatabase["simulation_run_events"];
type SimulationRunEventRow = Override<
  SimulationRunEventInput,
  {
    payload_json: any;
  }
>;

type SimulationRunDocumentInput =
  SimulationDatabase["simulation_run_documents"];
type SimulationRunDocumentRow = Override<
  SimulationRunDocumentInput,
  {
    error_json: any;
  }
>;

export type SimulationRunStatus =
  | "running"
  | "paused_on_error"
  | "paused_manual"
  | "completed";

export type SimulationPhase =
  | "ingest_diff"
  | "micro_batches"
  | "macro_synthesis"
  | "materialize_moments"
  | "deterministic_linking"
  | "candidate_sets"
  | "timeline_fit";

export const simulationPhases: readonly SimulationPhase[] = [
  "ingest_diff",
  "micro_batches",
  "macro_synthesis",
  "materialize_moments",
  "deterministic_linking",
  "candidate_sets",
  "timeline_fit",
];

const legacyPhaseMap: Record<string, SimulationPhase> = {
  A_ingest_diff: "ingest_diff",
  B_micro_batches: "micro_batches",
  C_macro_synthesis: "macro_synthesis",
  D_materialize_moments: "materialize_moments",
  E_deterministic_linking: "deterministic_linking",
  F_candidate_sets: "candidate_sets",
  G_timeline_fit: "timeline_fit",
};

function normalizePhase(phase: string | null | undefined): SimulationPhase {
  const raw = typeof phase === "string" ? phase : "";
  if (simulationPhases.includes(raw as SimulationPhase)) {
    return raw as SimulationPhase;
  }
  const legacy = legacyPhaseMap[raw];
  if (legacy) {
    return legacy;
  }
  return simulationPhases[0];
}

export type SimulationRunEventLevel = "debug" | "info" | "warn" | "error";

type SimulationDbContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
};

function getSimulationDb(context: SimulationDbContext) {
  return createDb<SimulationDatabase>(
    (context.env as any)
      .ENGINE_SIMULATION_STATE as DurableObjectNamespace<EngineSimulationStateDO>,
    qualifyName("engine-simulation-state", context.momentGraphNamespace)
  );
}

export async function createSimulationRun(
  context: SimulationDbContext,
  input: {
    runId: string;
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
    config?: Record<string, any> | null;
  }
): Promise<void> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  await db
    .insertInto("simulation_runs")
    .values({
      run_id: input.runId,
      status: "running",
      current_phase: simulationPhases[0],
      started_at: now,
      updated_at: now,
      last_progress_at: null,
      moment_graph_namespace: input.momentGraphNamespace,
      moment_graph_namespace_prefix: input.momentGraphNamespacePrefix,
      config_json: JSON.stringify(input.config ?? {}),
      last_error_json: null,
    } as any)
    .execute();
}

export async function getSimulationRunById(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<{
  runId: string;
  status: SimulationRunStatus | string;
  currentPhase: SimulationPhase | string;
  startedAt: string;
  updatedAt: string;
  lastProgressAt: string | null;
  momentGraphNamespace: string | null;
  momentGraphNamespacePrefix: string | null;
  config: any;
  lastError: any | null;
} | null> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return null;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .selectAll()
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as SimulationRunRow | undefined;

  if (!row) {
    return null;
  }

  return {
    runId: row.run_id,
    status: row.status,
    currentPhase: normalizePhase(row.current_phase),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lastProgressAt: row.last_progress_at ?? null,
    momentGraphNamespace: row.moment_graph_namespace ?? null,
    momentGraphNamespacePrefix: row.moment_graph_namespace_prefix ?? null,
    config: (row as any).config_json ?? {},
    lastError: (row as any).last_error_json ?? null,
  };
}

export async function addSimulationRunEvent(
  context: SimulationDbContext,
  input: {
    runId: string;
    level: SimulationRunEventLevel;
    kind: string;
    payload: Record<string, any>;
  }
): Promise<void> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return;
  }
  const kind =
    typeof input.kind === "string" && input.kind.length > 0
      ? input.kind
      : "event";
  const level: SimulationRunEventLevel =
    input.level === "debug" ||
    input.level === "info" ||
    input.level === "warn" ||
    input.level === "error"
      ? input.level
      : "info";
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db
    .insertInto("simulation_run_events")
    .values({
      id,
      run_id: runId,
      level,
      kind,
      payload_json: JSON.stringify(input.payload ?? {}),
      created_at: now,
    } as any)
    .execute();
}

export async function getSimulationRunEvents(
  context: SimulationDbContext,
  input: { runId: string; limit?: number }
): Promise<
  Array<{
    id: string;
    level: string;
    kind: string;
    createdAt: string;
    payload: any;
  }>
> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return [];
  }
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(500, Math.floor(limitRaw))
      : 200;

  const rows = (await db
    .selectFrom("simulation_run_events")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute()) as unknown as SimulationRunEventRow[];

  return rows.map((r) => ({
    id: r.id,
    level: r.level,
    kind: r.kind,
    createdAt: r.created_at,
    payload: (r as any).payload_json ?? {},
  }));
}

export async function getSimulationRunDocuments(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<
  Array<{
    r2Key: string;
    etag: string | null;
    documentHash: string | null;
    changed: boolean;
    error: any | null;
    processedAt: string;
    updatedAt: string;
  }>
> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return [];
  }

  const rows = (await db
    .selectFrom("simulation_run_documents")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("r2_key", "asc")
    .execute()) as unknown as SimulationRunDocumentRow[];

  return rows.map((r) => ({
    r2Key: r.r2_key,
    etag: r.etag ?? null,
    documentHash: r.document_hash ?? null,
    changed: Number((r as any).changed ?? 0) !== 0,
    error: (r as any).error_json ?? null,
    processedAt: r.processed_at,
    updatedAt: r.updated_at,
  }));
}

export async function setSimulationRunStatus(
  context: SimulationDbContext,
  input: { runId: string; status: SimulationRunStatus }
): Promise<void> {
  const db = getSimulationDb(context);
  await db
    .updateTable("simulation_runs")
    .set({
      status: input.status,
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", input.runId)
    .execute();
}

export async function pauseSimulationRunManual(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<boolean> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return false;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string }
    | undefined;

  if (!row) {
    return false;
  }

  if (row.status === "completed") {
    return true;
  }

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "run.pause_manual",
    payload: { previousStatus: row.status, currentPhase: row.current_phase },
  });

  await db
    .updateTable("simulation_runs")
    .set({
      status: "paused_manual",
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", runId)
    .execute();

  return true;
}

export async function resumeSimulationRun(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<boolean> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return false;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string }
    | undefined;

  if (!row) {
    return false;
  }

  if (row.status === "completed") {
    return true;
  }

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "run.resume",
    payload: { previousStatus: row.status, currentPhase: row.current_phase },
  });

  await db
    .updateTable("simulation_runs")
    .set({
      status: "running",
      updated_at: new Date().toISOString(),
    })
    .where("run_id", "=", runId)
    .execute();

  return true;
}

export async function restartSimulationRunFromPhase(
  context: SimulationDbContext,
  input: { runId: string; phase: SimulationPhase }
): Promise<boolean> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return false;
  }

  const phase = normalizePhase(input.phase);

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string }
    | undefined;

  if (!row) {
    return false;
  }

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "run.restart_from_phase",
    payload: {
      previousStatus: row.status,
      previousPhase: row.current_phase,
      phase,
    },
  });

  const now = new Date().toISOString();
  await db
    .updateTable("simulation_runs")
    .set({
      status: "running",
      current_phase: phase,
      updated_at: now,
      last_progress_at: null,
      last_error_json: null,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  return true;
}

export async function advanceSimulationRunPhaseNoop(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return null;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string }
    | undefined;

  if (!row) {
    return null;
  }

  if (row.status !== "running") {
    return { status: row.status, currentPhase: row.current_phase };
  }

  const phase = normalizePhase(row.current_phase);
  const phaseIdx = simulationPhases.indexOf(phase);

  if (phase === "ingest_diff") {
    return await runPhaseAIngestDiff(context, {
      runId,
      phaseIdx,
    });
  }

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "phase.start",
    payload: { phase },
  });

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "phase.end",
    payload: { phase, didWork: false },
  });

  const now = new Date().toISOString();
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;

  if (!nextPhase) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "completed",
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", runId)
      .execute();
    return { status: "completed", currentPhase: phase };
  }

  await db
    .updateTable("simulation_runs")
    .set({
      current_phase: nextPhase,
      updated_at: now,
      last_progress_at: now,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  return { status: "running", currentPhase: nextPhase };
}

async function runPhaseAIngestDiff(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["status", "config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | { status: string; config_json: any }
    | undefined;

  if (!runRow) {
    return null;
  }

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "ingest_diff", r2KeysCount: r2Keys.length },
  });

  let succeeded = 0;
  let failed = 0;
  let changed = 0;
  let unchanged = 0;
  const failures: Array<{ r2Key: string; error: string }> = [];

  const now = new Date().toISOString();

  for (const r2Key of r2Keys) {
    try {
      const bucket = (context.env as any).MACHINEN_BUCKET;
      const head = await bucket.head(r2Key);
      if (!head) {
        throw new Error("R2 object not found");
      }
      const etag = typeof head.etag === "string" ? head.etag : null;
      if (!etag) {
        throw new Error("Missing R2 etag");
      }

      const prev = (await db
        .selectFrom("simulation_run_documents")
        .select(["etag"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .executeTakeFirst()) as unknown as { etag: string | null } | undefined;

      const wasEtag = typeof prev?.etag === "string" ? prev.etag : null;
      const isChanged = !wasEtag || wasEtag !== etag;

      if (isChanged) {
        changed++;
      } else {
        unchanged++;
      }

      await db
        .insertInto("simulation_run_documents")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          etag,
          document_hash: null,
          changed: isChanged ? (1 as any) : (0 as any),
          error_json: null,
          processed_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            etag,
            document_hash: null,
            changed: isChanged ? (1 as any) : (0 as any),
            error_json: null,
            processed_at: now,
            updated_at: now,
          } as any)
        )
        .execute();

      succeeded++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });

      await db
        .insertInto("simulation_run_documents")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          etag: null,
          document_hash: null,
          changed: 1 as any,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            etag: null,
            document_hash: null,
            changed: 1 as any,
            error_json: JSON.stringify({ message: msg }),
            processed_at: now,
            updated_at: now,
          } as any)
        )
        .execute();
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "ingest_diff",
      r2KeysCount: r2Keys.length,
      succeeded,
      failed,
      changed,
      unchanged,
      didWork: r2Keys.length > 0,
    },
  });

  if (failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "Phase A ingest+diff failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "ingest_diff" };
  }

  const nextPhase = simulationPhases[input.phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "completed",
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "completed", currentPhase: "ingest_diff" };
  }

  await db
    .updateTable("simulation_runs")
    .set({
      current_phase: nextPhase,
      updated_at: now,
      last_progress_at: now,
    } as any)
    .where("run_id", "=", input.runId)
    .execute();

  return { status: "running", currentPhase: nextPhase };
}
