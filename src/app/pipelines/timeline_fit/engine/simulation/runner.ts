import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import {
  getSimulationDb,
  getMomentGraphDb,
} from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { addMoment, getMoments } from "../../../../engine/databases/momentGraph";
import { callLLM } from "../../../../engine/utils/llm";
import { computeTimelineFitDecision } from "../../../../engine/core/linking/timelineFitOrchestrator";

export async function runPhaseTimelineFit(
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
  const effectiveNamespace = applyMomentGraphNamespacePrefixValue(baseNamespace, prefix);

  const changedDocs = await db.selectFrom("simulation_run_documents").select("r2_key").where("run_id", "=", input.runId).where("changed", "=", 1).where("error_json", "is", null).execute();
  const relevantR2Keys = changedDocs.map(d => d.r2_key);

  if (!input.r2Key) {
    if (relevantR2Keys.length === 0) return advance(db, input.runId, input.phaseIdx, now);

    const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
    
    const finishedSet = new Set(processedKeys.filter(k => (((k as any).processed_phases_json || []) as string[]).includes("timeline_fit")).map(k => k.r2_key));
    const processedSet = new Set(processedKeys.map(k => k.r2_key));
    const dispatchMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !finishedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("timeline_fit");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, { runId: input.runId, level: "info", kind: "phase.dispatch_docs", payload: { phase: "timeline_fit", count: undecpatchedKeys.length } });
        for (const k of undecpatchedKeys) {
          const dispatched = (dispatchMap.get(k) || []) as string[];
          const nextDispatched = [...new Set([...dispatched, "timeline_fit"])];
          
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

          await queue.send({ jobType: "simulation-document", runId: input.runId, phase: "timeline_fit", r2Key: k });
        }
        return { status: "awaiting_documents", currentPhase: "timeline_fit" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0) {
      return { status: "awaiting_documents", currentPhase: "timeline_fit" };
    }
    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  const momentGraphContext = { env: context.env, momentGraphNamespace: effectiveNamespace ?? null };
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);
  const roots = await db.selectFrom("simulation_run_materialized_moments").select(["moment_id", "r2_key", "stream_id", "macro_index"]).where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).execute();
  const rootIds = roots.map(r => r.moment_id);
  const momentsList = rootIds.length > 0 ? await momentDb.selectFrom("moments").select(["id", "document_id", "created_at", "source_metadata", "title", "summary", "parent_id"]).where("id", "in", rootIds).execute() : [];
  const rootById = new Map((momentsList as any[]).map(r => [r.id, r]));

  for (const root of roots) {
    const child = rootById.get(root.moment_id);
    if (!child || child.parent_id) continue;

    try {
      const candidatesRow = await db.selectFrom("simulation_run_candidate_sets").select("candidates_json").where("run_id", "=", input.runId).where("child_moment_id", "=", root.moment_id).executeTakeFirst();
      const candidates = (candidatesRow?.candidates_json as any) ?? [];

      const deepCandidates = candidates.length > 0 ? await momentDb.selectFrom("moments").select(["id", "document_id", "title", "summary"]).where("id", "in", candidates.map((c: any) => c.id)).execute() : [];

      const proposal = await computeTimelineFitDecision({
        ports: { callLLM: (p) => callLLM(p, "slow-reasoning", { temperature: 0 }) },
        childMomentId: root.moment_id,
        childText: `${child.title ?? ""}\n${child.summary ?? ""}`.trim(),
        candidates: deepCandidates as any,
        useLlmVeto: true,
        maxAnchorTokens: 24,
        maxSharedAnchorTokens: 12,
      });

      if (proposal.chosenParentId) {
          await addMoment({ ...child, parentId: proposal.chosenParentId } as any, momentGraphContext);
      }

      await db.insertInto("simulation_run_timeline_fit_decisions").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: input.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, outcome: proposal.chosenParentId ? "attached" : "no_candidates", chosen_parent_moment_id: proposal.chosenParentId, decisions_json: JSON.stringify(proposal.decisions), stats_json: JSON.stringify(proposal.stats), created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", { phase: "timeline_fit", childMomentId: root.moment_id, r2Key: input.r2Key, error: msg });
    }
  }

  if (roots.length === 0) {
      await db.insertInto("simulation_run_timeline_fit_decisions").values({ run_id: input.runId, child_moment_id: `noop-${input.r2Key}`, r2_key: input.r2Key, stream_id: "none", macro_index: 0, outcome: "noop", chosen_parent_moment_id: null, decisions_json: "[]", stats_json: "{}", created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
  }

  // Mark doc as processed for this phase
  const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).executeTakeFirst();
  const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
  const nextPhases = [...new Set([...currentPhases, "timeline_fit"])];
  await db.updateTable("simulation_run_documents")
    .set({ processed_phases_json: nextPhases as any, updated_at: now })
    .where("run_id", "=", input.runId)
    .where("r2_key", "=", input.r2Key)
    .execute();

  return { status: "running", currentPhase: "timeline_fit" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "timeline_fit" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
