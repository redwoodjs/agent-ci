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
  SimulationRunArtifactRow,
} from "./types";
import { getSimulationDb, getMomentGraphDb } from "./db";

/**
 * Helper to fetch moment details (title, summary, etc.) across potentially multiple namespaces.
 * It first checks `simulation_run_participating_namespaces`.
 * If empty, it falls back to known legacy namespaces + the run's default.
 */
/**
 * Helper to fetch raw moment rows across all participating namespaces for a run.
 * Used by runners (timeline_fit, candidate_sets, linking) to find moments without needing to re-route.
 */
export async function fetchMomentsFromRun(
  context: SimulationDbContext,
  runId: string,
  momentIds: string[]
): Promise<any[]> {
  const db = getSimulationDb(context);
  const distinctIds = Array.from(new Set(momentIds)).filter(Boolean);
  
  if (distinctIds.length === 0) {
    return [];
  }

  // 1. Get run info for legacy fallback
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

  // 2. Try to get explicitly recorded namespaces from the run
  const participatingRows = await db
    .selectFrom("simulation_run_participating_namespaces")
    .select("namespace")
    .where("run_id", "=", runId)
    .execute();

  const namespacesToCheck = new Set<string | null>();

  // Always add explicitly recorded namespaces
  if (participatingRows.length > 0) {
    participatingRows.forEach((r) => namespacesToCheck.add(r.namespace));
  }

  // AND ALWAYS add fallback namespaces to be safe (for mixed runs or missed recordings)
  const candidateBaseNamespaces = [
    baseNamespace, // The run's default
    "redwood:rwsdk",
    "redwood:machinen",
    "redwood:internal",
    null, // Default/global
  ];

  for (const base of candidateBaseNamespaces) {
    const effective =
      base && prefix
        ? applyMomentGraphNamespacePrefixValue(base, prefix)
        : prefix && !base
        ? prefix // If base is null but prefix exists, it's just the prefix
        : applyMomentGraphNamespacePrefixValue(base, prefix);
    namespacesToCheck.add(effective);
  }

  // 3. Query all candidate namespaces in parallel
  const results = await Promise.all(
    Array.from(namespacesToCheck).map(async (ns) => {
      try {
        const momentDb = getMomentGraphDb(context.env, ns);
        const rows = await momentDb
          .selectFrom("moments")
          .select([
            "id",
            "document_id",
            "parent_id",
            "title",
            "summary",
            "source_metadata",
            "author",
            "created_at",
            "importance",
            "is_subject",
            "moment_kind",
          ])
          .where("id", "in", distinctIds as any)
          .execute();
        return rows.map(r => ({ ...r, _namespace: ns }));
      } catch (e) {
        // Ignore errors from missing namespaces or DB failures
        return [];
      }
    })
  );

  return results.flat();
}

/**
 * Helper to fetch moment details (title, summary, etc.) across potentially multiple namespaces.
 */
async function fetchMomentDetails(
  context: SimulationDbContext,
  runId: string,
  momentIds: string[]
): Promise<
  Map<
    string,
    {
      parentId: string | null;
      title: string | null;
      summary: string | null;
      sourceMetadata: any | null;
      author: string | null;
      createdAt: string | null;
    }
  >
> {
  const rows = await fetchMomentsFromRun(context, runId, momentIds);
  const detailsMap = new Map<string, any>();

  for (const r of rows) {
    if (!detailsMap.has(r.id)) {
      detailsMap.set(r.id, {
        parentId: r.parent_id ?? null,
        title: r.title ?? null,
        summary: r.summary ?? null,
        sourceMetadata: r.source_metadata ?? null,
        author: r.author ?? null,
        createdAt: r.created_at ?? null,
      });
    }
  }

  return detailsMap;
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "micro_batches")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const out: any[] = [];
  for (const r of rows) {
    const output = r.output_json;
    if (output && Array.isArray(output.batches)) {
      for (const b of output.batches) {
        out.push({
          r2Key: r.artifact_key,
          batchIndex: b.batchIndex,
          batchHash: b.batchHash,
          promptContextHash: b.promptContextHash,
          status: b.cached ? "cached" : "computed",
          items: b.microItems || [],
          error: null, // Unified artifacts don't store per-batch error yet
          createdAt: r.created_at,
          updatedAt: r.updated_at || r.created_at,
        });
      }
    }
  }

  return out;
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "macro_synthesis")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  return rows.map((r) => {
    const o = r.output_json ?? {};
    return {
      r2Key: r.artifact_key,
      microStreamHash: o.microStreamHash ?? "",
      useLlm: !!o.useLlm,
      streams: o.streams ?? [],
      audit: o.audit ?? null,
      gating: o.gating ?? null,
      anchors: o.anchors ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
    };
  });
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "macro_classification")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  return rows.map((r) => {
    const o = r.output_json ?? {};
    return {
      r2Key: r.artifact_key,
      streams: o.streams ?? [],
      gating: o.gating ?? null,
      classifications: o.classifications ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
    };
  });
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "materialize_moments")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "like", `${r2Key}/%`);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const moments: any[] = [];
  for (const r of rows) {
    const o = r.output_json ?? {};
    if (Array.isArray(o.moments)) {
        for (const m of o.moments) {
            moments.push({
                r2Key: r.artifact_key.split("/")[0],
                streamId: r.artifact_key.split("/")[1],
                macroIndex: Number(r.artifact_key.split("/")[2] || 0),
                momentId: m.momentId,
                parentId: m.parentId ?? null,
                title: m.title ?? null,
                summary: m.summary ?? null,
                sourceMetadata: m.sourceMetadata ?? null,
                author: m.author ?? null,
                createdAt: r.created_at,
                updatedAt: r.updated_at || r.created_at,
            });
        }
    }
  }

  return moments;
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "deterministic_linking")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "like", `${r2Key}/%`);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    if (o.childMomentId && !o.childMomentId.startsWith("noop-")) {
        momentIds.add(o.childMomentId);
    }
    if (o.parentMomentId) momentIds.add(o.parentMomentId);
  }
  const detailsById = await fetchMomentDetails(
    context,
    runId,
    Array.from(momentIds)
  );

  return rows.map((r) => {
    const o = r.output_json ?? {};
    const isNoop = o.childMomentId?.startsWith("noop-");
    const child = detailsById.get(o.childMomentId);
    const parent = o.parentMomentId
      ? detailsById.get(o.parentMomentId)
      : null;
    return {
      r2Key: o.r2Key || r.artifact_key.split("/")[0],
      streamId: o.streamId || r.artifact_key.split("/")[1],
      macroIndex: Number(o.macroIndex ?? (r.artifact_key.split("/")[2] || 0)),
      childMomentId: o.childMomentId,
      childTitle: isNoop ? "No Materialized Moments" : (child?.title ?? null),
      childSummary: isNoop ? "No moments were found in this document." : (child?.summary ?? null),
      parentMomentId: o.parentMomentId ?? null,
      parentTitle: parent?.title ?? null,
      parentSummary: parent?.summary ?? null,
      phase: o.phase || r.phase,
      outcome: o.outcome,
      ruleId: typeof o.ruleId === "string" ? o.ruleId : null,
      evidence: o.evidence ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "candidate_sets")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "like", `${r2Key}/%`);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    if (o.childMomentId && !o.childMomentId.startsWith("noop-")) {
        momentIds.add(o.childMomentId);
    }
    const candidates = o.candidates;
    if (Array.isArray(candidates)) {
      for (const c of candidates) {
        if (c.momentId) momentIds.add(c.momentId);
      }
    }
  }

  const detailsById = await fetchMomentDetails(
    context,
    runId,
    Array.from(momentIds)
  );

  return rows.map((r) => {
    const o = r.output_json ?? {};
    const isNoop = o.childMomentId?.startsWith("noop-");
    const child = detailsById.get(o.childMomentId);
    const rawCandidates = Array.isArray(o.candidates)
      ? (o.candidates as any[])
      : [];
    const candidates = rawCandidates.map((c) => {
      const id = c.id || c.momentId;
      const details = detailsById.get(id);
      return {
        ...c,
        momentId: id,
        title: details?.title ?? null,
        summary: details?.summary ?? null,
      };
    });

    return {
      r2Key: o.r2Key || r.artifact_key.split("/")[0],
      streamId: o.streamId || r.artifact_key.split("/")[1],
      macroIndex: Number(o.macroIndex ?? (r.artifact_key.split("/")[2] || 0)),
      childMomentId: o.childMomentId,
      childTitle: isNoop ? "No Materialized Moments" : (child?.title ?? null),
      childSummary: isNoop ? "No moments were found in this document to fit onto the timeline." : (child?.summary ?? null),
      candidates,
      stats: o.stats ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
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
    .selectFrom("simulation_run_artifacts")
    .where("run_id", "=", runId)
    .where("phase", "=", "timeline_fit")
    .selectAll();

  if (r2Key) {
    q = q.where("artifact_key", "like", `${r2Key}/%`);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    if (o.childMomentId && !o.childMomentId.startsWith("noop-")) {
        momentIds.add(o.childMomentId);
    }
    if (o.chosenParentMomentId)
      momentIds.add(o.chosenParentMomentId);
    const decisions = o.decisions;
    if (Array.isArray(decisions)) {
      for (const d of decisions) {
        if (d.candidateId) momentIds.add(d.candidateId);
      }
    }
  }

  const detailsById = await fetchMomentDetails(
    context,
    runId,
    Array.from(momentIds)
  );

  return rows.map((r) => {
    const o = r.output_json ?? {};
    const isNoop = o.childMomentId?.startsWith("noop-");
    const child = detailsById.get(o.childMomentId);
    const chosenParent = o.chosenParentMomentId
      ? detailsById.get(o.chosenParentMomentId)
      : null;
    const rawDecisions = Array.isArray(o.decisions)
      ? (o.decisions as any[])
      : [];
    const decisions = rawDecisions.map((d) => {
      const details = detailsById.get(d.candidateId);
      return {
        ...d,
        candidateTitle: details?.title ?? null,
        candidateSummary: details?.summary ?? null,
      };
    });

    return {
      r2Key: o.r2Key || r.artifact_key.split("/")[0],
      streamId: o.streamId || r.artifact_key.split("/")[1],
      macroIndex: Number(o.macroIndex ?? (r.artifact_key.split("/")[2] || 0)),
      childMomentId: o.childMomentId,
      childTitle: isNoop ? "No Materialized Moments" : (child?.title ?? null),
      childSummary: isNoop ? "No moments were found in this document to fit onto the timeline." : (child?.summary ?? null),
      outcome: o.outcome,
      chosenParentMomentId: o.chosenParentMomentId ?? null,
      chosenParentTitle: chosenParent?.title ?? null,
      chosenParentSummary: chosenParent?.summary ?? null,
      decisions,
      stats: o.stats ?? null,
      createdAt: r.created_at,
      updatedAt: r.updated_at || r.created_at,
    };
  });
}


