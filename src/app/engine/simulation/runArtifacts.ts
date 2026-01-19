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
    items: string[];
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
    .leftJoin("simulation_micro_batch_cache", (join) =>
      join
        .onRef(
          "simulation_run_micro_batches.batch_hash",
          "=",
          "simulation_micro_batch_cache.batch_hash"
        )
        .onRef(
          "simulation_run_micro_batches.prompt_context_hash",
          "=",
          "simulation_micro_batch_cache.prompt_context_hash"
        )
    )
    .select([
      "simulation_run_micro_batches.r2_key",
      "simulation_run_micro_batches.batch_index",
      "simulation_run_micro_batches.batch_hash",
      "simulation_run_micro_batches.prompt_context_hash",
      "simulation_run_micro_batches.status",
      "simulation_run_micro_batches.error_json",
      "simulation_run_micro_batches.created_at",
      "simulation_run_micro_batches.updated_at",
      "simulation_micro_batch_cache.micro_items_json",
    ])
    .where("run_id", "=", runId);

  if (r2Key) {
    q = q.where("r2_key", "=", r2Key);
  }

  const rows = await q
    .orderBy("r2_key", "asc")
    .orderBy("batch_index", "asc")
    .execute();

  return rows.map((r) => {
    const itemsRaw = (r as any).micro_items_json;
    const items = Array.isArray(itemsRaw)
      ? (itemsRaw as string[])
      : typeof itemsRaw === "string"
      ? (JSON.parse(itemsRaw) as string[])
      : [];

    return {
      r2Key: r.r2_key,
      batchIndex: Number((r as any).batch_index ?? 0),
      batchHash: r.batch_hash,
      promptContextHash: r.prompt_context_hash,
      status: r.status,
      items,
      error: (r as any).error_json ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
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
    title: string | null;
        summary: string | null;
    sourceMetadata: any | null;
    author: string | null;
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
  const momentRows =
    ids.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "parent_id", "title", "summary", "source_metadata", "author"])
          .where("id", "in", ids as any)
          .execute()
      : [];
  const detailsById = new Map(
    (momentRows as any[]).map((r) => [
      r.id,
      {
        parentId: r.parent_id ?? null,
        title: r.title ?? null,
        summary: r.summary ?? null,
        sourceMetadata: r.source_metadata ?? null,
        author: r.author ?? null,
      },
    ])
  );

  return rows.map((r) => {
    const details = detailsById.get((r as any).moment_id);
    return {
      r2Key: (r as any).r2_key,
      streamId: (r as any).stream_id,
      macroIndex: Number((r as any).macro_index ?? 0),
      momentId: (r as any).moment_id,
      parentId: details?.parentId ?? null,
      title: details?.title ?? null,
      summary: details?.summary ?? null,
      sourceMetadata: details?.sourceMetadata ?? null,
      author: details?.author ?? null,
      createdAt: (r as any).created_at,
      updatedAt: (r as any).updated_at,
    };
  });
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
    childTitle: string | null;
    childSummary: string | null;
    parentMomentId: string | null;
    parentTitle: string | null;
    parentSummary: string | null;
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

  const runRow = await db
    .selectFrom("simulation_runs")
    .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", runId)
    .executeTakeFirst();
  const effectiveNamespace =
    runRow?.moment_graph_namespace && runRow?.moment_graph_namespace_prefix
      ? applyMomentGraphNamespacePrefixValue(
          runRow.moment_graph_namespace,
          runRow.moment_graph_namespace_prefix
        )
      : runRow?.moment_graph_namespace;
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  const momentIds = new Set<string>();
  for (const r of rows) {
    if ((r as any).child_moment_id) momentIds.add((r as any).child_moment_id);
    if ((r as any).parent_moment_id) momentIds.add((r as any).parent_moment_id);
  }
  const ids = Array.from(momentIds);
  const momentRows =
    ids.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "title", "summary"])
          .where("id", "in", ids as any)
          .execute()
      : [];
  const detailsById = new Map(
    (momentRows as any[]).map((r) => [
      r.id,
      { title: r.title ?? null, summary: r.summary ?? null },
    ])
  );

  return rows.map((r) => {
    const child = detailsById.get((r as any).child_moment_id);
    const parent = (r as any).parent_moment_id
      ? detailsById.get((r as any).parent_moment_id)
      : null;
    return {
      r2Key: (r as any).r2_key,
      streamId: (r as any).stream_id,
      macroIndex: Number((r as any).macro_index ?? 0),
      childMomentId: (r as any).child_moment_id,
      childTitle: child?.title ?? null,
      childSummary: child?.summary ?? null,
      parentMomentId: (r as any).parent_moment_id ?? null,
      parentTitle: parent?.title ?? null,
      parentSummary: parent?.summary ?? null,
      phase: (r as any).phase,
      outcome: (r as any).outcome,
      ruleId: typeof (r as any).rule_id === "string" ? (r as any).rule_id : null,
      evidence: (r as any).evidence_json ?? null,
      createdAt: (r as any).created_at,
      updatedAt: (r as any).updated_at,
    };
  });
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
    childTitle: string | null;
    childSummary: string | null;
    candidates: Array<{
      momentId: string;
      title?: string | null;
      summary?: string | null;
      [key: string]: any;
    }>;
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

  const runRow = await db
    .selectFrom("simulation_runs")
    .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", runId)
    .executeTakeFirst();
  const effectiveNamespace =
    runRow?.moment_graph_namespace && runRow?.moment_graph_namespace_prefix
      ? applyMomentGraphNamespacePrefixValue(
          runRow.moment_graph_namespace,
          runRow.moment_graph_namespace_prefix
        )
      : runRow?.moment_graph_namespace;
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  const momentIds = new Set<string>();
  for (const r of rows) {
    if ((r as any).child_moment_id) momentIds.add((r as any).child_moment_id);
    const candidates = (r as any).candidates_json;
    if (Array.isArray(candidates)) {
      for (const c of candidates) {
        if (c.momentId) momentIds.add(c.momentId);
      }
    }
  }

  const ids = Array.from(momentIds);
  const momentRows =
    ids.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "title", "summary"])
          .where("id", "in", ids as any)
          .execute()
      : [];
  const detailsById = new Map(
    (momentRows as any[]).map((r) => [
      r.id,
      { title: r.title ?? null, summary: r.summary ?? null },
    ])
  );

  return rows.map((r) => {
    const child = detailsById.get((r as any).child_moment_id);
    const rawCandidates = Array.isArray((r as any).candidates_json)
      ? ((r as any).candidates_json as any[])
      : [];
    const candidates = rawCandidates.map((c) => {
      const details = detailsById.get(c.momentId);
      return {
        ...c,
        title: details?.title ?? null,
        summary: details?.summary ?? null,
      };
    });

    return {
      r2Key: (r as any).r2_key,
      streamId: (r as any).stream_id,
      macroIndex: Number((r as any).macro_index ?? 0),
      childMomentId: (r as any).child_moment_id,
      childTitle: child?.title ?? null,
      childSummary: child?.summary ?? null,
      candidates,
      stats: (r as any).stats_json ?? null,
      createdAt: (r as any).created_at,
      updatedAt: (r as any).updated_at,
    };
  });
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
    childTitle: string | null;
    childSummary: string | null;
    outcome: string;
    chosenParentMomentId: string | null;
    chosenParentTitle: string | null;
    chosenParentSummary: string | null;
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

  const runRow = await db
    .selectFrom("simulation_runs")
    .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", runId)
    .executeTakeFirst();
  const effectiveNamespace =
    runRow?.moment_graph_namespace && runRow?.moment_graph_namespace_prefix
      ? applyMomentGraphNamespacePrefixValue(
          runRow.moment_graph_namespace,
          runRow.moment_graph_namespace_prefix
        )
      : runRow?.moment_graph_namespace;
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  const momentIds = new Set<string>();
  for (const r of rows) {
    if ((r as any).child_moment_id) momentIds.add((r as any).child_moment_id);
    if ((r as any).chosen_parent_moment_id)
      momentIds.add((r as any).chosen_parent_moment_id);
    const decisions = (r as any).decisions_json;
    if (Array.isArray(decisions)) {
      for (const d of decisions) {
        if (d.candidateMomentId) momentIds.add(d.candidateMomentId);
      }
    }
  }

  const ids = Array.from(momentIds);
  const momentRows =
    ids.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "title", "summary"])
          .where("id", "in", ids as any)
          .execute()
      : [];
  const detailsById = new Map(
    (momentRows as any[]).map((r) => [
      r.id,
      { title: r.title ?? null, summary: r.summary ?? null },
    ])
  );

  return rows.map((r) => {
    const child = detailsById.get((r as any).child_moment_id);
    const chosenParent = (r as any).chosen_parent_moment_id
      ? detailsById.get((r as any).chosen_parent_moment_id)
      : null;
    const rawDecisions = Array.isArray((r as any).decisions_json)
      ? ((r as any).decisions_json as any[])
      : [];
    const decisions = rawDecisions.map((d) => {
      const details = detailsById.get(d.candidateMomentId);
      return {
        ...d,
        candidateTitle: details?.title ?? null,
        candidateSummary: details?.summary ?? null,
      };
    });

    return {
      r2Key: (r as any).r2_key,
      streamId: (r as any).stream_id,
      macroIndex: Number((r as any).macro_index ?? 0),
      childMomentId: (r as any).child_moment_id,
      childTitle: child?.title ?? null,
      childSummary: child?.summary ?? null,
      outcome: (r as any).outcome,
      chosenParentMomentId: (r as any).chosen_parent_moment_id ?? null,
      chosenParentTitle: chosenParent?.title ?? null,
      chosenParentSummary: chosenParent?.summary ?? null,
      decisions,
      stats: (r as any).stats_json ?? null,
      createdAt: (r as any).created_at,
      updatedAt: (r as any).updated_at,
    };
  });
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

