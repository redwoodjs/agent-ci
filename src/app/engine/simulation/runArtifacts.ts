import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";
import type {
  SimulationDbContext,
  SimulationRunDocumentRow,
  SimulationRunMicroBatchRow,
  SimulationRunMacroOutputRow,
  SimulationRunMacroClassifiedOutputRow,
  SimulationRunMaterializedMomentRow,
  SimulationRunLinkDecisionRow,
  SimulationRunCandidateSetRow,
  SimulationRunTimelineFitDecisionRow,
  SimulationMicroBatchCacheRow,
} from "./types";
import { getSimulationDb, getMomentGraphDb } from "./db";

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

export async function getSimulationRunMacroClassifiedOutputs(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    streams: any;
    gating: any | null;
    classifications: any | null;
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
    .selectFrom("simulation_run_macro_classified_outputs")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .execute()) as unknown as SimulationRunMacroClassifiedOutputRow[];

  return rows.map((r) => ({
    r2Key: (r as any).r2_key,
    streams: (r as any).streams_json ?? [],
    gating: (r as any).gating_json ?? null,
    classifications: (r as any).classification_json ?? null,
    createdAt: (r as any).created_at,
    updatedAt: (r as any).updated_at,
  }));
}

export async function getSimulationRunMaterializedMoments(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    streamId: string;
    macroIndex: number;
    momentId: string;
    parentId: string | null;
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
    .selectFrom("simulation_run_materialized_moments")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .orderBy("stream_id", "asc")
    .orderBy("macro_index", "asc")
    .execute()) as unknown as SimulationRunMaterializedMomentRow[];

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | {
        moment_graph_namespace: string | null;
        moment_graph_namespace_prefix: string | null;
      }
    | undefined;

  const baseNamespace =
    typeof (runRow as any)?.moment_graph_namespace === "string"
      ? ((runRow as any).moment_graph_namespace as string)
      : null;
  const prefix =
    typeof (runRow as any)?.moment_graph_namespace_prefix === "string"
      ? ((runRow as any).moment_graph_namespace_prefix as string)
      : null;
  const effectiveNamespace =
    baseNamespace && prefix
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix)
      : baseNamespace;

  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);
  const ids = rows.map((r) => (r as any).moment_id).filter(Boolean);
  const parentRows =
    ids.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "parent_id"])
          .where("id", "in", ids as any)
          .execute()
      : [];
  const parentById = new Map(
    (parentRows as any[]).map((r) => [r.id, r.parent_id ?? null])
  );

  return rows.map((r) => ({
    r2Key: (r as any).r2_key,
    streamId: (r as any).stream_id,
    macroIndex: Number((r as any).macro_index ?? 0),
    momentId: (r as any).moment_id,
    parentId: parentById.get((r as any).moment_id) ?? null,
    createdAt: (r as any).created_at,
    updatedAt: (r as any).updated_at,
  }));
}

export async function getSimulationRunLinkDecisions(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    streamId: string;
    macroIndex: number;
    childMomentId: string;
    parentMomentId: string | null;
    phase: string;
    outcome: string;
    ruleId: string | null;
    evidence: any | null;
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
    .selectFrom("simulation_run_link_decisions")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .orderBy("stream_id", "asc")
    .orderBy("macro_index", "asc")
    .execute()) as unknown as SimulationRunLinkDecisionRow[];

  return rows.map((r) => ({
    r2Key: (r as any).r2_key,
    streamId: (r as any).stream_id,
    macroIndex: Number((r as any).macro_index ?? 0),
    childMomentId: (r as any).child_moment_id,
    parentMomentId: (r as any).parent_moment_id ?? null,
    phase: (r as any).phase,
    outcome: (r as any).outcome,
    ruleId: typeof (r as any).rule_id === "string" ? (r as any).rule_id : null,
    evidence: (r as any).evidence_json ?? null,
    createdAt: (r as any).created_at,
    updatedAt: (r as any).updated_at,
  }));
}

export async function getSimulationRunCandidateSets(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    streamId: string;
    macroIndex: number;
    childMomentId: string;
    candidates: any[];
    stats: any | null;
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
    .selectFrom("simulation_run_candidate_sets")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .orderBy("stream_id", "asc")
    .orderBy("macro_index", "asc")
    .execute()) as unknown as SimulationRunCandidateSetRow[];

  return rows.map((r) => ({
    r2Key: (r as any).r2_key,
    streamId: (r as any).stream_id,
    macroIndex: Number((r as any).macro_index ?? 0),
    childMomentId: (r as any).child_moment_id,
    candidates: Array.isArray((r as any).candidates_json)
      ? ((r as any).candidates_json as any[])
      : [],
    stats: (r as any).stats_json ?? null,
    createdAt: (r as any).created_at,
    updatedAt: (r as any).updated_at,
  }));
}

export async function getSimulationRunTimelineFitDecisions(
  context: SimulationDbContext,
  input: { runId: string; r2Key?: string | null }
): Promise<
  Array<{
    r2Key: string;
    streamId: string;
    macroIndex: number;
    childMomentId: string;
    outcome: string;
    chosenParentMomentId: string | null;
    decisions: any[];
    stats: any | null;
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
    .selectFrom("simulation_run_timeline_fit_decisions")
    .selectAll()
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("r2_key", "asc")
    .orderBy("stream_id", "asc")
    .orderBy("macro_index", "asc")
    .execute()) as unknown as SimulationRunTimelineFitDecisionRow[];

  return rows.map((r) => ({
    r2Key: (r as any).r2_key,
    streamId: (r as any).stream_id,
    macroIndex: Number((r as any).macro_index ?? 0),
    childMomentId: (r as any).child_moment_id,
    outcome: (r as any).outcome,
    chosenParentMomentId: (r as any).chosen_parent_moment_id ?? null,
    decisions: Array.isArray((r as any).decisions_json)
      ? ((r as any).decisions_json as any[])
      : [],
    stats: (r as any).stats_json ?? null,
    createdAt: (r as any).created_at,
    updatedAt: (r as any).updated_at,
  }));
}

export async function getMicroBatchCacheEntry(
  context: SimulationDbContext,
  input: { batchHash: string; promptContextHash: string }
): Promise<SimulationMicroBatchCacheRow | null> {
  const db = getSimulationDb(context);
  const row = (await db
    .selectFrom("simulation_micro_batch_cache")
    .select(["micro_items_json"])
    .where("batch_hash", "=", input.batchHash)
    .where("prompt_context_hash", "=", input.promptContextHash)
    .executeTakeFirst()) as unknown as SimulationMicroBatchCacheRow | undefined;
  return row ?? null;
}

