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

export type SimulationRunStatus =
  | "running"
  | "paused_on_error"
  | "paused_manual"
  | "completed";

export type SimulationPhase =
  | "A_ingest_diff"
  | "B_micro_batches"
  | "C_macro_synthesis"
  | "D_materialize_moments"
  | "E_deterministic_linking"
  | "F_candidate_sets"
  | "G_timeline_fit";

export const simulationPhases: readonly SimulationPhase[] = [
  "A_ingest_diff",
  "B_micro_batches",
  "C_macro_synthesis",
  "D_materialize_moments",
  "E_deterministic_linking",
  "F_candidate_sets",
  "G_timeline_fit",
];

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
    currentPhase: row.current_phase,
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

  const phase = input.phase;
  if (!simulationPhases.includes(phase)) {
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

  const currentPhase = row.current_phase;
  const idx = simulationPhases.indexOf(currentPhase as SimulationPhase);
  const phaseIdx = idx >= 0 ? idx : 0;
  const phase = simulationPhases[phaseIdx];

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
    return { status: "completed", currentPhase };
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

