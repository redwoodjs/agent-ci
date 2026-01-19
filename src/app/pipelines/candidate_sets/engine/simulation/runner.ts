import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import {
  getSimulationDb,
  getMomentGraphDb,
} from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { getEmbedding } from "../../../../engine/utils/vector";
import { computeCandidateSet } from "../../../../engine/core/linking/candidateSetsOrchestrator";

export async function runPhaseCandidateSets(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });
  const verbosityRaw = String((context.env as any).MACHINEN_SIMULATION_EVENT_VERBOSITY ?? "").trim().toLowerCase();
  const verbose = verbosityRaw === "1" || verbosityRaw === "true" || verbosityRaw === "verbose" || verbosityRaw === "item";

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json", "moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as any;

  if (!runRow) return null;

  const baseNamespace = runRow.moment_graph_namespace;
  const prefix = runRow.moment_graph_namespace_prefix;
  const effectiveNamespace = baseNamespace && prefix ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix) : baseNamespace;

  // 1. Get relevant documents (those changed in ingest_diff)
  const changedDocs = await db.selectFrom("simulation_run_documents").select("r2_key").where("run_id", "=", input.runId).where("changed", "=", 1).where("error_json", "is", null).execute();
  const relevantR2Keys = changedDocs.map(d => d.r2_key);

  if (!input.r2Key) {
    if (relevantR2Keys.length === 0) return advance(db, input.runId, input.phaseIdx, now);

    const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
    
    const finishedSet = new Set(processedKeys.filter(k => (((k as any).processed_phases_json || []) as string[]).includes("candidate_sets")).map(k => k.r2_key));
    const processedSet = new Set(processedKeys.map(k => k.r2_key));
    const dispatchMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !finishedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("candidate_sets");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, { runId: input.runId, level: "info", kind: "phase.dispatch_docs", payload: { phase: "candidate_sets", count: undecpatchedKeys.length } });
        for (const k of undecpatchedKeys) {
          const dispatched = (dispatchMap.get(k) || []) as string[];
          const nextDispatched = [...new Set([...dispatched, "candidate_sets"])];
          
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: k,
              changed: 1, // Must be 1 if we're here
              processed_at: "pending",
              updated_at: now,
              dispatched_phases_json: nextDispatched,
              processed_phases_json: [],
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
              dispatched_phases_json: nextDispatched,
              updated_at: now,
            } as any))
            .execute();

          await queue.send({ jobType: "simulation-document", runId: input.runId, phase: "candidate_sets", r2Key: k });
        }
        return { status: "awaiting_documents", currentPhase: "candidate_sets" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0) {
      return { status: "awaiting_documents", currentPhase: "candidate_sets" };
    }
    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);
  const roots = await db.selectFrom("simulation_run_materialized_moments").select(["moment_id", "r2_key", "stream_id", "macro_index"]).where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).execute();
  const rootIds = roots.map(r => r.moment_id);
  const moments = rootIds.length > 0 ? await momentDb.selectFrom("moments").select(["id", "document_id", "created_at", "source_metadata", "title", "summary", "parent_id"]).where("id", "in", rootIds).execute() : [];
  const rootById = new Map((moments as any[]).map(r => [r.id, r]));

  for (const root of roots) {
    const childRow = rootById.get(root.moment_id);
    if (!childRow || childRow.parent_id) continue;

    const queryText = (childRow.summary?.trim() || childRow.title?.trim() || "");
    if (!queryText) {
      await db.insertInto("simulation_run_candidate_sets").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: input.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, candidates_json: "[]", stats_json: '{"reason":"empty-query"}', created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
      continue;
    }

    try {
      const built = await computeCandidateSet({
        ports: {
          getEmbedding: async (text) => await getEmbedding(text),
          vectorQuery: async (embedding, query) => {
            const results = await (context.env as any).MOMENT_INDEX.query(embedding, { topK: query.topK, returnMetadata: true, filter: (effectiveNamespace ?? "default") !== "default" ? { momentGraphNamespace: effectiveNamespace ?? "default" } : undefined });
            return { matches: (results?.matches ?? []).map((m: any) => ({ id: m.id, score: m.score })) };
          },
          loadCandidateRowsById: async (ids) => {
            const rows = ids.length > 0 ? await momentDb.selectFrom("moments").select(["id", "document_id", "created_at", "source_metadata", "title", "summary"]).where("id", "in", ids as any).execute() : [];
            return new Map((rows as any[]).map(r => [r.id, r]));
          },
        },
        childMomentId: root.moment_id,
        childDocumentId: childRow.document_id,
        childCreatedAt: childRow.created_at,
        childSourceMetadata: childRow.source_metadata ?? undefined,
        childText: queryText,
        maxCandidates: 10,
        vectorTopK: 20,
      });
      await db.insertInto("simulation_run_candidate_sets").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: input.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, candidates_json: JSON.stringify(built.candidates), stats_json: JSON.stringify(built.stats), created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ candidates_json: JSON.stringify(built.candidates), stats_json: JSON.stringify(built.stats), updated_at: now } as any)).execute();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", { phase: "candidate_sets", childMomentId: root.moment_id, r2Key: input.r2Key, error: msg });
    }
  }

  // Ensure doc marked as done
  if (roots.length === 0) {
      await db.insertInto("simulation_run_candidate_sets").values({ run_id: input.runId, child_moment_id: `noop-${input.r2Key}`, r2_key: input.r2Key, stream_id: "none", macro_index: 0, candidates_json: "[]", stats_json: "{}", created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
  }

  // Mark doc as processed for this phase
  const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).executeTakeFirst();
  const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
  const nextPhases = [...new Set([...currentPhases, "candidate_sets"])];
  await db.updateTable("simulation_run_documents")
    .set({ processed_phases_json: nextPhases as any, updated_at: now })
    .where("run_id", "=", input.runId)
    .where("r2_key", "=", input.r2Key)
    .execute();

  return { status: "running", currentPhase: "candidate_sets" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "candidate_sets" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
