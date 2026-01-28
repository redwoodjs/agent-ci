import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb, getMomentGraphDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { addMoment } from "../../../../engine/databases/momentGraph";
import { callLLM } from "../../../../engine/utils/llm";
import { fetchMomentsFromRun } from "../../../../engine/simulation/runArtifacts";
import { computeTimelineFitDecision } from "../../../../engine/core/linking/timelineFitOrchestrator";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";
import { timelineFitRoutes } from "../../web/routes/timeline-fit";
import { TimelineFitDecisionsCard } from "../../web/ui/TimelineFitDecisionsCard";
import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";

export const timeline_fit_simulation: PipelineRegistryEntry = {
  phase: "timeline_fit" as const,
  label: "Timeline Fit",

  onTick: runStandardDocumentPolling({ phase: "timeline_fit" }),

  async onExecute(context, input) {
    // ... (rest of onExecute remains same as before)
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

    // Granular execution
    const roots = await db.selectFrom("simulation_run_materialized_moments").select(["moment_id", "r2_key", "stream_id", "macro_index"]).where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).execute();
    const rootIds = roots.map(r => r.moment_id);
    
    const momentsList = await fetchMomentsFromRun(context, input.runId, rootIds);
    const rootById = new Map((momentsList as any[]).map(r => [r.id, r]));

    try {
      for (const root of roots) {
        const child = rootById.get(root.moment_id);
        if (!child || child.parentId) continue;
        
        const momentGraphContext = { env: context.env, momentGraphNamespace: child._namespace };

        const candidatesRow = await db.selectFrom("simulation_run_candidate_sets").select("candidates_json").where("run_id", "=", input.runId).where("child_moment_id", "=", root.moment_id).executeTakeFirst();
        const candidates = (candidatesRow?.candidates_json as any) ?? [];
        const candidateIds = candidates.map((c: any) => c.id);

        const deepCandidatesList = candidateIds.length > 0 ? await fetchMomentsFromRun(context, input.runId, candidateIds) : [];

        const proposal = await computeTimelineFitDecision({
          ports: { callLLM: (p) => callLLM(p, "slow-reasoning", { temperature: 0 }) },
          childMomentId: root.moment_id,
          childText: `${child.title ?? ""}\n${child.summary ?? ""}`.trim(),
          candidates: deepCandidatesList as any,
          useLlmVeto: true,
          maxAnchorTokens: 24,
          maxSharedAnchorTokens: 12,
        });

        if (proposal.chosenParentId) {
          const linkAuditLog = {
            kind: "timeline_fit",
            ruleId: "anchor_token_fit",
            evidence: {
              phase: "timeline_fit",
              r2Key: workUnit.r2Key,
              streamId: root.stream_id,
              macroIndex: root.macro_index,
              chosenParentId: proposal.chosenParentId,
              decisions: proposal.decisions,
              stats: proposal.stats,
              veto: proposal.veto,
            },
          } as any;
          await addMoment(
            {
              ...child,
              parentId: proposal.chosenParentId,
              linkAuditLog,
            } as any,
            momentGraphContext
          );
        }

        await db.insertInto("simulation_run_timeline_fit_decisions").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: workUnit.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, outcome: proposal.chosenParentId ? "fit" : "no_fit", chosen_parent_moment_id: proposal.chosenParentId, decisions_json: JSON.stringify(proposal.decisions), stats_json: JSON.stringify(proposal.stats), created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", { phase: "timeline_fit", r2Key: workUnit.r2Key, error: msg });
      await db.updateTable("simulation_run_documents")
        .set({ error_json: JSON.stringify({ error: msg }) as any, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
    }

    // Mark doc as processed for this phase
    const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
    const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
    const nextPhases = [...new Set([...currentPhases, "timeline_fit"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextPhases as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  web: {
    routes: timelineFitRoutes,
    ui: {
      drilldown: TimelineFitDecisionsCard,
    },
  },

  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "timeline_fit" }),
};

registerPipeline(timeline_fit_simulation);
