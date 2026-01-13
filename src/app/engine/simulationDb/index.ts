import { type Database, createDb } from "rwsdk/db";
import type { EngineSimulationStateDO } from "./durableObject";
import { simulationStateMigrations } from "./migrations";
import { qualifyName } from "../momentGraphNamespace";
import { Override } from "@/app/shared/kyselyTypeOverrides";
import {
  createEngineContext,
  type Chunk,
  type Document,
  type IndexingHookContext,
  type Plugin,
} from "../index";
import { computeMicroMomentsForChunkBatch } from "../subjects/computeMicroMomentsForChunkBatch";
import { synthesizeMicroMomentsIntoStreams } from "../synthesis/synthesizeMicroMoments";

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

type SimulationRunMicroBatchInput =
  SimulationDatabase["simulation_run_micro_batches"];
type SimulationRunMicroBatchRow = Override<
  SimulationRunMicroBatchInput,
  {
    error_json: any;
  }
>;

type SimulationMicroBatchCacheInput =
  SimulationDatabase["simulation_micro_batch_cache"];
type SimulationMicroBatchCacheRow = Override<
  SimulationMicroBatchCacheInput,
  {
    micro_items_json: any;
  }
>;

type SimulationRunMacroOutputInput =
  SimulationDatabase["simulation_run_macro_outputs"];
type SimulationRunMacroOutputRow = Override<
  SimulationRunMacroOutputInput,
  {
    streams_json: any;
    audit_json: any;
    gating_json: any;
    anchors_json: any;
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

export function createSimulationRunLogger(
  context: SimulationDbContext,
  input: { runId: string; persistInfo?: boolean }
): {
  error: (kind: string, payload: Record<string, any>) => Promise<void>;
  warn: (kind: string, payload: Record<string, any>) => Promise<void>;
  info: (kind: string, payload: Record<string, any>) => Promise<void>;
} {
  const runId = typeof input.runId === "string" ? input.runId.trim() : "";
  const persistInfo =
    input.persistInfo === true ||
    String((context.env as any).SIMULATION_AUDIT_PERSIST_INFO ?? "") === "1";

  return {
    async error(kind, payload) {
      console.error(`[simulation:${runId}] ${kind}`, payload);
      await addSimulationRunEvent(context, {
        runId,
        level: "error",
        kind,
        payload,
      });
    },
    async warn(kind, payload) {
      console.warn(`[simulation:${runId}] ${kind}`, payload);
      await addSimulationRunEvent(context, {
        runId,
        level: "warn",
        kind,
        payload,
      });
    },
    async info(kind, payload) {
      if (persistInfo) {
        await addSimulationRunEvent(context, {
          runId,
          level: "info",
          kind,
          payload,
        });
      }
    },
  };
}

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
    config: (row as any).config_json ?? {},
    lastError: (row as any).last_error_json ?? null,
  }));
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

export async function getSimulationRunMicroBatches(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    batchIndex: number;
    batchHash: string;
    promptContextHash: string;
    status: string;
    error: any | null;
    createdAt: string;
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

  const r2Key =
    typeof input.r2Key === "string" && input.r2Key.trim().length > 0
      ? input.r2Key.trim()
      : null;

  let q = db
    .selectFrom("simulation_run_micro_batches")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .orderBy("batch_index", "asc")
    .execute()) as unknown as SimulationRunMicroBatchRow[];

  return rows.map((r) => ({
    r2Key: r.r2_key,
    batchIndex: Number((r as any).batch_index ?? 0),
    batchHash: r.batch_hash,
    promptContextHash: r.prompt_context_hash,
    status: r.status,
    error: (r as any).error_json ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function getSimulationRunMacroOutputs(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    microStreamHash: string;
    useLlm: boolean;
    streams: any;
    audit: any | null;
    gating: any | null;
    anchors: any | null;
    createdAt: string;
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

  const r2Key =
    typeof input.r2Key === "string" && input.r2Key.trim().length > 0
      ? input.r2Key.trim()
      : null;

  let q = db
    .selectFrom("simulation_run_macro_outputs")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .execute()) as unknown as SimulationRunMacroOutputRow[];

  return rows.map((r) => ({
    r2Key: r.r2_key,
    microStreamHash: (r as any).micro_stream_hash ?? "",
    useLlm: Number((r as any).use_llm ?? 0) !== 0,
    streams: (r as any).streams_json ?? [],
    audit: (r as any).audit_json ?? null,
    gating: (r as any).gating_json ?? null,
    anchors: (r as any).anchors_json ?? null,
    createdAt: r.created_at,
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

  try {
    if (phase === "ingest_diff") {
      return await runPhaseAIngestDiff(context, {
        runId,
        phaseIdx,
      });
    }

    if (phase === "micro_batches") {
      return await runPhaseMicroBatches(context, {
        runId,
        phaseIdx,
      });
    }

    if (phase === "macro_synthesis") {
      return await runPhaseMacroSynthesis(context, {
        runId,
        phaseIdx,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: "phase.error",
      payload: { phase, error: msg },
    });
    const now = new Date().toISOString();
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: msg,
          phase,
        }),
      } as any)
      .where("run_id", "=", runId)
      .execute();
    return { status: "paused_on_error", currentPhase: phase };
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

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function chunkChunksForMicroComputation(
  chunks: Chunk[],
  opts: { maxBatchChars: number; maxChunkChars: number; maxBatchItems: number }
): Chunk[][] {
  const maxBatchChars =
    Number.isFinite(opts.maxBatchChars) && opts.maxBatchChars > 0
      ? opts.maxBatchChars
      : 10_000;
  const maxChunkChars =
    Number.isFinite(opts.maxChunkChars) && opts.maxChunkChars > 0
      ? opts.maxChunkChars
      : 2_000;
  const maxBatchItems =
    Number.isFinite(opts.maxBatchItems) && opts.maxBatchItems > 0
      ? opts.maxBatchItems
      : 10;

  const out: Chunk[][] = [];
  let currentBatch: Chunk[] = [];
  let currentChars = 0;

  function flush() {
    if (currentBatch.length > 0) {
      out.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
  }

  for (const chunk of chunks) {
    const content = truncateToChars(chunk.content ?? "", maxChunkChars);
    const projectedChars = currentChars + content.length;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchItems || projectedChars > maxBatchChars)
    ) {
      flush();
    }

    currentBatch.push({
      ...chunk,
      content,
    });
    currentChars += content.length;

    if (currentBatch.length >= maxBatchItems || currentChars > maxBatchChars) {
      flush();
    }
  }

  flush();
  return out;
}

async function runFirstMatchHook<T>(
  plugins: Plugin[],
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T | null> {
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

async function prepareDocumentForR2Key(
  r2Key: string,
  env: Cloudflare.Env,
  plugins: Plugin[]
): Promise<{ document: Document; indexingContext: IndexingHookContext }> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env,
    momentGraphNamespace: null,
    indexingMode: "indexing",
  };

  const document = await runFirstMatchHook(plugins, (plugin) =>
    plugin.prepareSourceDocument?.(indexingContext)
  );
  if (!document) {
    throw new Error("No plugin could prepare document");
  }
  return { document, indexingContext };
}

async function splitDocumentIntoChunks(
  document: Document,
  indexingContext: IndexingHookContext,
  plugins: Plugin[]
): Promise<Chunk[]> {
  const chunks = await runFirstMatchHook(plugins, (plugin) =>
    plugin.splitDocumentIntoChunks?.(document, indexingContext)
  );
  if (!chunks || chunks.length === 0) {
    throw new Error("No plugin could split document into chunks");
  }
  return chunks;
}

async function getMicroPromptContext(
  document: Document,
  chunks: Chunk[],
  indexingContext: IndexingHookContext,
  plugins: Plugin[]
): Promise<string> {
  const microPromptContext = await runFirstMatchHook(plugins, (plugin) =>
    plugin.subjects?.getMicroMomentBatchPromptContext?.(
      document,
      chunks,
      indexingContext
    )
  );

  return (
    microPromptContext ??
    `Context: These chunks are from a single document.\n` +
      `Focus on concrete details and avoid generic summaries.\n`
  );
}

function computeMicroItemsWithoutLlm(batchChunks: Chunk[]): string[] {
  const items = batchChunks
    .map((c) => (c.content ?? "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((c) => c.slice(0, 300));
  if (items.length > 0) {
    return items;
  }
  return ["(empty batch)"];
}

function extractAnchorTokens(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(token: string) {
    const t = token.trim();
    if (!t) {
      return;
    }
    if (seen.has(t)) {
      return;
    }
    seen.add(t);
    out.push(t);
  }

  const canon = text.match(/mchn:\/\/[a-z]+\/[^\s)\]]+/g) ?? [];
  for (const m of canon) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const issueRefs = text.match(/#\d{2,6}/g) ?? [];
  for (const m of issueRefs) {
    add(m);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  const backtick = text.match(/`([^`]{1,80})`/g) ?? [];
  for (const m of backtick) {
    const inner = m.slice(1, -1);
    add(inner);
    if (out.length >= maxTokens) {
      return out;
    }
  }

  return out;
}

async function runPhaseMicroBatches(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as { config_json: any } | undefined;

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
    payload: { phase: "micro_batches", r2KeysCount: r2Keys.length },
  });

  const env = context.env;
  const useLlm =
    String((env as any).SIMULATION_MICRO_BATCH_USE_LLM ?? "") === "1";

  const engineContext = createEngineContext(env, "indexing");
  const plugins = engineContext.plugins;

  let docsProcessed = 0;
  let docsSkippedUnchanged = 0;
  let batchesComputed = 0;
  let batchesCached = 0;
  let failed = 0;

  const failures: Array<{ r2Key: string; error: string }> = [];

  for (const r2Key of r2Keys) {
    const docState = (await db
      .selectFrom("simulation_run_documents")
      .select(["changed", "error_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | { changed: number; error_json: any }
      | undefined;

    const hadError = Boolean((docState as any)?.error_json);
    const changedFlag = Number((docState as any)?.changed ?? 1) !== 0;

    if (hadError) {
      failed++;
      failures.push({ r2Key, error: "ingest_diff error" });
      continue;
    }

    if (!changedFlag) {
      docsSkippedUnchanged++;
      continue;
    }

    docsProcessed++;

    try {
      const { document, indexingContext } = await prepareDocumentForR2Key(
        r2Key,
        env,
        plugins
      );
      const chunks = await splitDocumentIntoChunks(
        document,
        indexingContext,
        plugins
      );

      const chunkBatchSizeRaw = (env as any).MICRO_MOMENT_CHUNK_BATCH_SIZE;
      const chunkBatchMaxCharsRaw = (env as any)
        .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
      const chunkMaxCharsRaw = (env as any).MICRO_MOMENT_CHUNK_MAX_CHARS;

      const chunkBatchSize =
        typeof chunkBatchSizeRaw === "string"
          ? Number.parseInt(chunkBatchSizeRaw, 10)
          : typeof chunkBatchSizeRaw === "number"
          ? chunkBatchSizeRaw
          : 10;
      const chunkBatchMaxChars =
        typeof chunkBatchMaxCharsRaw === "string"
          ? Number.parseInt(chunkBatchMaxCharsRaw, 10)
          : typeof chunkBatchMaxCharsRaw === "number"
          ? chunkBatchMaxCharsRaw
          : 10_000;
      const chunkMaxChars =
        typeof chunkMaxCharsRaw === "string"
          ? Number.parseInt(chunkMaxCharsRaw, 10)
          : typeof chunkMaxCharsRaw === "number"
          ? chunkMaxCharsRaw
          : 2_000;

      const chunkBatches = chunkChunksForMicroComputation(chunks, {
        maxBatchChars: chunkBatchMaxChars,
        maxChunkChars: chunkMaxChars,
        maxBatchItems: chunkBatchSize,
      });

      for (let batchIndex = 0; batchIndex < chunkBatches.length; batchIndex++) {
        const batchChunks = chunkBatches[batchIndex] ?? [];
        const batchKeyParts = batchChunks.map((c) => {
          const hash = c.contentHash ?? "";
          return `${c.id}:${hash}`;
        });
        const batchHash = await sha256Hex(batchKeyParts.join("\n"));

        const promptContext = await getMicroPromptContext(
          document,
          batchChunks,
          indexingContext,
          plugins
        );
        const promptContextHash = await sha256Hex(promptContext);

        const cached = (await db
          .selectFrom("simulation_micro_batch_cache")
          .select(["micro_items_json"])
          .where("batch_hash", "=", batchHash)
          .where("prompt_context_hash", "=", promptContextHash)
          .executeTakeFirst()) as unknown as
          | SimulationMicroBatchCacheRow
          | undefined;

        if (cached) {
          batchesCached++;
          await db
            .insertInto("simulation_run_micro_batches")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              batch_index: batchIndex as any,
              batch_hash: batchHash,
              prompt_context_hash: promptContextHash,
              status: "cached",
              error_json: null,
              created_at: now,
              updated_at: now,
            } as any)
            .onConflict((oc) =>
              oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
                batch_hash: batchHash,
                prompt_context_hash: promptContextHash,
                status: "cached",
                error_json: null,
                updated_at: now,
              } as any)
            )
            .execute();
          continue;
        }

        let microItems: string[] = [];
        if (useLlm) {
          microItems =
            (await computeMicroMomentsForChunkBatch(batchChunks, {
              promptContext,
            })) ?? [];
        }

        if (microItems.length === 0) {
          microItems = computeMicroItemsWithoutLlm(batchChunks);
        }

        await db
          .insertInto("simulation_micro_batch_cache")
          .values({
            batch_hash: batchHash,
            prompt_context_hash: promptContextHash,
            micro_items_json: JSON.stringify(microItems),
            created_at: now,
            updated_at: now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["batch_hash", "prompt_context_hash"]).doUpdateSet({
              micro_items_json: JSON.stringify(microItems),
              updated_at: now,
            } as any)
          )
          .execute();

        batchesComputed++;

        await db
          .insertInto("simulation_run_micro_batches")
          .values({
            run_id: input.runId,
            r2_key: r2Key,
            batch_index: batchIndex as any,
            batch_hash: batchHash,
            prompt_context_hash: promptContextHash,
            status: useLlm ? "computed_llm" : "computed_fallback",
            error_json: null,
            created_at: now,
            updated_at: now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
              batch_hash: batchHash,
              prompt_context_hash: promptContextHash,
              status: useLlm ? "computed_llm" : "computed_fallback",
              error_json: null,
              updated_at: now,
            } as any)
          )
          .execute();
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "micro_batches",
        r2Key,
        error: msg,
      });
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "micro_batches",
      useLlm,
      r2KeysCount: r2Keys.length,
      docsProcessed,
      docsSkippedUnchanged,
      batchesComputed,
      batchesCached,
      failed,
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
          message: "micro_batches failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "micro_batches" };
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
    return { status: "completed", currentPhase: "micro_batches" };
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

async function runPhaseMacroSynthesis(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as { config_json: any } | undefined;

  if (!runRow) {
    return null;
  }

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  const env = context.env;
  const useLlm = String((env as any).SIMULATION_MACRO_USE_LLM ?? "") === "1";

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "macro_synthesis", r2KeysCount: r2Keys.length, useLlm },
  });

  const engineContext = createEngineContext(env, "indexing");
  const plugins = engineContext.plugins;

  let docsProcessed = 0;
  let docsReused = 0;
  let docsSkippedUnchanged = 0;
  let failed = 0;
  let streamsProduced = 0;
  let macroMomentsProduced = 0;

  const failures: Array<{ r2Key: string; error: string }> = [];

  for (const r2Key of r2Keys) {
    const docState = (await db
      .selectFrom("simulation_run_documents")
      .select(["changed", "error_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | { changed: number; error_json: any }
      | undefined;

    const hadError = Boolean((docState as any)?.error_json);
    const changedFlag = Number((docState as any)?.changed ?? 1) !== 0;

    if (hadError) {
      failed++;
      failures.push({ r2Key, error: "ingest_diff error" });
      continue;
    }

    if (!changedFlag) {
      docsSkippedUnchanged++;
      continue;
    }

    try {
      const batches = (await db
        .selectFrom("simulation_run_micro_batches")
        .select(["batch_index", "batch_hash", "prompt_context_hash"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .orderBy("batch_index", "asc")
        .execute()) as unknown as Array<{
        batch_index: number;
        batch_hash: string;
        prompt_context_hash: string;
      }>;

      const identityParts = batches.map(
        (b) => `${b.batch_hash}:${b.prompt_context_hash}`
      );
      const microStreamHash = await sha256Hex(identityParts.join("\n"));

      const existing = (await db
        .selectFrom("simulation_run_macro_outputs")
        .select(["micro_stream_hash"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .executeTakeFirst()) as unknown as
        | { micro_stream_hash: string }
        | undefined;

      const prevHash =
        typeof (existing as any)?.micro_stream_hash === "string"
          ? (existing as any).micro_stream_hash
          : null;

      if (prevHash && prevHash === microStreamHash) {
        docsReused++;
        continue;
      }

      docsProcessed++;

      const { document, indexingContext } = await prepareDocumentForR2Key(
        r2Key,
        env,
        plugins
      );

      const macroPromptContext = await runFirstMatchHook(plugins, (plugin) =>
        plugin.subjects?.getMacroSynthesisPromptContext?.(
          document,
          indexingContext
        )
      );

      const microItems: Array<{
        path: string;
        summary: string;
        createdAt: string;
      }> = [];

      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        const cached = (await db
          .selectFrom("simulation_micro_batch_cache")
          .select(["micro_items_json"])
          .where("batch_hash", "=", b.batch_hash)
          .where("prompt_context_hash", "=", b.prompt_context_hash)
          .executeTakeFirst()) as unknown as
          | SimulationMicroBatchCacheRow
          | undefined;
        const items =
          (cached as any)?.micro_items_json &&
          Array.isArray((cached as any).micro_items_json)
            ? ((cached as any).micro_items_json as any[])
            : [];
        const asStrings = items
          .filter((x) => typeof x === "string")
          .map((x) => (x as string).trim())
          .filter(Boolean);
        for (let j = 0; j < asStrings.length; j++) {
          microItems.push({
            path: `${r2Key}#${i}#${j}`,
            summary: asStrings[j],
            createdAt: now,
          });
        }
      }

      const auditEvents: any[] = [];

      let streams: any[] = [];
      if (useLlm) {
        const llmStreams = await synthesizeMicroMomentsIntoStreams(
          microItems.map((m) => ({ ...m } as any)),
          {
            macroSynthesisPromptContext: macroPromptContext ?? null,
            auditSink: (event) => {
              auditEvents.push(event);
            },
          }
        );
        streams = llmStreams;
      } else {
        const joined = microItems
          .map((m) => m.summary)
          .filter(Boolean)
          .slice(0, 8)
          .join(" ");
        streams = [
          {
            streamId: "stream-1",
            macroMoments: [
              {
                title: `Synthesis for ${document.id}`,
                summary: joined || "(empty)",
                microPaths: microItems.slice(0, 50).map((m) => m.path),
                importance: 0.5,
                createdAt: now,
              },
            ],
          },
        ];
      }

      const anchors: string[] = [];
      for (const s of streams) {
        const moments = Array.isArray((s as any).macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        for (const m of moments) {
          const text = `${m.title ?? ""}\n${m.summary ?? ""}`.trim();
          for (const tok of extractAnchorTokens(text, 25)) {
            anchors.push(tok);
          }
        }
      }

      const gating = {
        keptStreams: streams.length,
        droppedStreams: 0,
      };

      streamsProduced += streams.length;
      for (const s of streams) {
        const mm = Array.isArray((s as any).macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        macroMomentsProduced += mm.length;
      }

      await db
        .insertInto("simulation_run_macro_outputs")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          micro_stream_hash: microStreamHash,
          use_llm: useLlm ? (1 as any) : (0 as any),
          streams_json: JSON.stringify(streams),
          audit_json:
            auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
          gating_json: JSON.stringify(gating),
          anchors_json: JSON.stringify(anchors.slice(0, 200)),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            micro_stream_hash: microStreamHash,
            use_llm: useLlm ? (1 as any) : (0 as any),
            streams_json: JSON.stringify(streams),
            audit_json:
              auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
            gating_json: JSON.stringify(gating),
            anchors_json: JSON.stringify(anchors.slice(0, 200)),
            updated_at: now,
          } as any)
        )
        .execute();
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "macro_synthesis",
        r2Key,
        error: msg,
      });
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "macro_synthesis",
      useLlm,
      r2KeysCount: r2Keys.length,
      docsProcessed,
      docsReused,
      docsSkippedUnchanged,
      streamsProduced,
      macroMomentsProduced,
      failed,
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
          message: "macro_synthesis failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "macro_synthesis" };
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
    return { status: "completed", currentPhase: "macro_synthesis" };
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

async function runPhaseAIngestDiff(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const log = createSimulationRunLogger(context, { runId: input.runId });

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
      await log.error("item.error", {
        phase: "ingest_diff",
        r2Key,
        error: msg,
      });

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
