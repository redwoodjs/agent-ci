import type {
  SimulationDbContext,
  SimulationPhase,
  SimulationRunStatus,
  SimulationRunRow,
} from "./types";
import { simulationPhases } from "./types";
import { getSimulationDb } from "./db";
import { addSimulationRunEvent } from "./runEvents";
import { computeSimulationRunPrefixBase } from "../utils/simulationRunPrefix";

const legacyPhaseMap: Record<string, SimulationPhase> = {
  A_ingest_diff: "ingest_diff",
  B_micro_batches: "micro_batches",
  C_macro_synthesis: "macro_synthesis",
  D_materialize_moments: "materialize_moments",
  E_deterministic_linking: "deterministic_linking",
  F_candidate_sets: "candidate_sets",
  G_timeline_fit: "timeline_fit",
};

export function normalizePhase(phase: string | null | undefined): SimulationPhase {
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
  const nowDate = new Date();
  const now = nowDate.toISOString();

  const inputPrefix =
    typeof input.momentGraphNamespacePrefix === "string" &&
    input.momentGraphNamespacePrefix.trim().length > 0
      ? input.momentGraphNamespacePrefix.trim()
      : null;

  const momentGraphNamespacePrefix = await (async () => {
    if (inputPrefix) {
      return inputPrefix;
    }
    const base = computeSimulationRunPrefixBase({ env: context.env, now: nowDate });
    const row = (await db
      .selectFrom("simulation_runs")
      .select([(db.fn as any).countAll().as("count")])
      .where("moment_graph_namespace_prefix", "=", base)
      .executeTakeFirst()) as any;
    const count =
      typeof row?.count === "number"
        ? row.count
        : typeof row?.count === "string" && Number.isFinite(Number(row.count))
        ? Number(row.count)
        : 0;
    return count > 0 ? `${base}-${count + 1}` : base;
  })();

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
      moment_graph_namespace_prefix: momentGraphNamespacePrefix,
      config_json: JSON.stringify(input.config ?? {}),
      last_error_json: null,
    })
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
    config: row.config_json ?? {},
    lastError: row.last_error_json ?? null,
  };
}

export async function getRecentSimulationRuns(
  context: SimulationDbContext,
  input: { limit?: number }
): Promise<
  Array<{
    runId: string;
    status: string;
    currentPhase: SimulationPhase | string;
    startedAt: string;
    updatedAt: string;
    lastProgressAt: string | null;
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
    config: any;
    lastError: any | null;
  }>
> {
  const db = getSimulationDb(context);
  const limitRaw = input.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : 50;

  const rows = (await db
    .selectFrom("simulation_runs")
    .selectAll()
    .orderBy("started_at", "desc")
    .limit(limit)
    .execute()) as unknown as SimulationRunRow[];

  return rows.map((row) => ({
    runId: row.run_id,
    status: row.status,
    currentPhase: normalizePhase(row.current_phase),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    lastProgressAt: row.last_progress_at ?? null,
    momentGraphNamespace: row.moment_graph_namespace ?? null,
    momentGraphNamespacePrefix: row.moment_graph_namespace_prefix ?? null,
    config: row.config_json ?? {},
    lastError: row.last_error_json ?? null,
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

  // Clear document tracking for this phase and subsequent ones
  const phaseIdx = simulationPhases.indexOf(phase);
  const phasesToClear = simulationPhases.slice(phaseIdx);

  // We can't easily clear specific phases from the JSON array in SQL without complexity, 
  // but we can at least clear processed_at for all docs if we restart from ingest_diff or anytime we want a full re-eval.
  // Actually, the safest is to just clear the dispatched_phases_json and processed_at for all docs 
  // because ingest_diff is the only one that sets processed_at on simulation_run_documents.
  if (phase === "ingest_diff") {
     await db.updateTable("simulation_run_documents")
      .set({ processed_at: "pending", dispatched_phases_json: null, processed_phases_json: null, changed: 0, error_json: null } as any)
      .where("run_id", "=", runId)
      .execute();
  } else {
     // For other phases, we just need to ensure they don't think they've already dispatched or processed
     // We'll do a crude clear for now to be safe.
      await db.updateTable("simulation_run_documents")
      .set({ dispatched_phases_json: null, processed_phases_json: null, error_json: null } as any)
      .where("run_id", "=", runId)
      .execute();
  }

  // Clear artifact tables
  const artifactTables = [
    "simulation_run_micro_batches",
    "simulation_run_macro_outputs",
    "simulation_run_macro_classified_outputs",
    "simulation_run_materialized_moments",
    "simulation_run_link_decisions",
    "simulation_run_candidate_sets",
    "simulation_run_timeline_fit_decisions"
  ];

  // We only clear tables that correspond to the restarted phase and LATER.
  // This is a bit mapping-heavy, so let's just clear all of them for now to be safe, 
  // or use the phase index to filter.
  const tablesToClear = artifactTables.slice(Math.max(0, phaseIdx - 1)); // -1 because ingest_diff doesn't have a table in this list

  for (const table of tablesToClear) {
    await db.deleteFrom(table as any).where("run_id", "=", runId).execute();
  }

  return true;
}

