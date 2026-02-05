import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";
import type {
  SimulationDbContext,
  SimulationRunDocumentRow,
  SimulationRunR2BatchRow,
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
    q = q.where("artifact_key", "=", r2Key);
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
                r2Key: r.artifact_key,
                streamId: m.sourceMetadata?.simulation?.streamId || "default",
                macroIndex: Number(m.sourceMetadata?.simulation?.macroIndex ?? 0),
                momentId: m.id,
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
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    const decisions = Array.isArray(o.decisions) ? o.decisions : [];
    for (const d of decisions) {
      // Prioritize checking if metadata is already present in the decision artifact
      if (d.childMomentId && !d.childMomentId.startsWith("noop-") && !d.childTitle) {
        momentIds.add(d.childMomentId);
      }
      const pId = d.proposedParentId || d.parentMomentId;
      if (pId && !d.parentTitle) {
        momentIds.add(pId);
      }
    }
  }

  if (momentIds.size === 0 && rows.length > 0) {
    console.log(`[run-artifacts] Using enriched data for ${rows.length} decisions (JSON-Blob-First)`);
  }

  const detailsById = momentIds.size > 0 
    ? await fetchMomentDetails(context, runId, Array.from(momentIds))
    : new Map<string, any>();

  const flatResults: any[] = [];
  for (const r of rows) {
    const o = r.output_json ?? {};
    const decisions = Array.isArray(o.decisions) ? o.decisions : [];
    
    for (const d of decisions) {
      const child = detailsById.get(d.childMomentId);
      const parentId = d.proposedParentId || d.parentMomentId;
      const parent = parentId ? detailsById.get(parentId) : null;
      
      flatResults.push({
        r2Key: r.artifact_key,
        streamId: d.streamId || "default",
        macroIndex: Number(d.macroIndex ?? 0),
        childMomentId: d.childMomentId,
        childTitle: d.childTitle || child?.title || null,
        childSummary: d.childSummary || child?.summary || null,
        parentMomentId: parentId ?? null,
        parentTitle: d.parentTitle || parent?.title || null,
        parentSummary: d.parentSummary || parent?.summary || null,
        phase: r.phase,
        outcome: d.outcome,
        ruleId: d.ruleId ?? null,
        evidence: d.evidence ?? d.audit ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
      });
    }

    if (decisions.length === 0 && o.childMomentId?.startsWith("noop-")) {
      flatResults.push({
        r2Key: r.artifact_key,
        streamId: "default",
        macroIndex: 0,
        childMomentId: o.childMomentId,
        childTitle: "No Materialized Moments",
        childSummary: "No moments were found in this document.",
        parentMomentId: null,
        parentTitle: null,
        parentSummary: null,
        phase: r.phase,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
      });
    }
  }

  return flatResults;
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
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    const candidateSets = o.candidateSets || {};
    
    for (const momentId of Object.keys(candidateSets)) {
      const set = candidateSets[momentId];
      if (!momentId.startsWith("noop-") && !set?.childTitle) {
        momentIds.add(momentId);
      }
      const candidates = Array.isArray(set?.candidates) ? set.candidates : [];
      for (const c of candidates) {
        const id = c.id || c.momentId;
        if (id && !c.title) momentIds.add(id);
      }
    }
  }

  const detailsById = momentIds.size > 0
    ? await fetchMomentDetails(context, runId, Array.from(momentIds))
    : new Map<string, any>();

  const flatResults: any[] = [];
  for (const r of rows) {
    const o = r.output_json ?? {};
    const candidateSets = o.candidateSets || {};
    
    for (const momentId of Object.keys(candidateSets)) {
      const set = candidateSets[momentId];
      const isNoop = momentId.startsWith("noop-");
      const child = detailsById.get(momentId);
      const rawCandidates = Array.isArray(set?.candidates) ? set.candidates : [];
      
      const candidates = rawCandidates.map((c: any) => {
        const id = c.id || c.momentId;
        const details = detailsById.get(id);
        return {
          ...c,
          momentId: id,
          title: c.title || details?.title || null,
          summary: c.summary || details?.summary || null,
        };
      });

      flatResults.push({
        r2Key: r.artifact_key,
        streamId: set?.streamId || "default",
        macroIndex: Number(set?.macroIndex ?? 0),
        childMomentId: momentId,
        childTitle: isNoop ? "No Materialized Moments" : (set?.childTitle || child?.title || null),
        childSummary: isNoop ? "No moments were found in this document to fit onto the timeline." : (set?.childSummary || child?.summary || null),
        candidates,
        stats: set?.stats || o.stats || null,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
      });
    }
  }

  return flatResults;
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
    q = q.where("artifact_key", "=", r2Key);
  }

  const rows = (await q
    .orderBy("artifact_key", "asc")
    .execute()) as unknown as SimulationRunArtifactRow[];

  const momentIds = new Set<string>();
  for (const r of rows) {
    const o = r.output_json ?? {};
    const decisionsMap = o.decisions || {};
    
    for (const momentId of Object.keys(decisionsMap)) {
      const decision = decisionsMap[momentId];
      if (!momentId.startsWith("noop-") && !decision.childTitle) {
        momentIds.add(momentId);
      }
      const pId = decision.chosenParentId;
      if (pId && !decision.chosenParentTitle) {
        momentIds.add(pId);
      }
      const candidates = Array.isArray(decision.decisions) ? decision.decisions : [];
      for (const c of candidates) {
        if (c.candidateId && !c.title) momentIds.add(c.candidateId);
      }
    }
  }

  const detailsById = momentIds.size > 0
    ? await fetchMomentDetails(context, runId, Array.from(momentIds))
    : new Map<string, any>();

  const flatResults: any[] = [];
  for (const r of rows) {
    const o = r.output_json ?? {};
    const decisionsMap = o.decisions || {};
    
    for (const momentId of Object.keys(decisionsMap)) {
      const decision = decisionsMap[momentId];
      const isNoop = momentId.startsWith("noop-");
      const child = detailsById.get(momentId);
      const chosenParent = decision.chosenParentId
        ? detailsById.get(decision.chosenParentId)
        : null;
        
      const rawDecisions = Array.isArray(decision.decisions)
        ? (decision.decisions as any[])
        : [];
      const detailedDecisions = rawDecisions.map((d) => {
        const details = detailsById.get(d.candidateId);
        return {
          ...d,
          candidateTitle: d.title || details?.title || null,
          candidateSummary: d.summary || details?.summary || null,
        };
      });

      flatResults.push({
        r2Key: r.artifact_key,
        streamId: decision.streamId || "default",
        macroIndex: Number(decision.macroIndex ?? 0),
        childMomentId: momentId,
        childTitle: isNoop ? "No Materialized Moments" : (decision.childTitle || child?.title || null),
        childSummary: isNoop ? "No moments were found in this document to fit onto the timeline." : (decision.childSummary || child?.summary || null),
        outcome: decision.outcome || "unknown",
        chosenParentMomentId: decision.chosenParentId ?? null,
        chosenParentTitle: decision.chosenParentTitle || chosenParent?.title || null,
        chosenParentSummary: decision.chosenParentSummary || chosenParent?.summary || null,
        decisions: detailedDecisions,
        stats: decision.stats ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at || r.created_at,
      });
    }
  }

  return flatResults;
}


