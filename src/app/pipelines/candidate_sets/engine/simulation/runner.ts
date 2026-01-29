import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb, getMomentGraphDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { getEmbedding } from "../../../../engine/utils/vector";
import { fetchMomentsFromRun } from "../../../../engine/simulation/runArtifacts";
import { computeCandidateSet } from "../../../../engine/core/linking/candidateSetsOrchestrator";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";
import { candidateSetsRoutes } from "../../web/routes/candidate-sets";
import { CandidateSetsCard } from "../../web/ui/CandidateSetsCard";
import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";

export const candidate_sets_simulation: PipelineRegistryEntry = {
  phase: "candidate_sets" as const,
  label: "Candidate Sets",

  onTick: runStandardDocumentPolling({ phase: "candidate_sets" }),

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
    const moments = await fetchMomentsFromRun(context, input.runId, rootIds);
    const rootById = new Map((moments as any[]).map(r => [r.id, r]));

    for (const root of roots) {
      const childRow = rootById.get(root.moment_id);
      if (!childRow || childRow.parent_id) continue;

      const queryText = (childRow.summary?.trim() || childRow.title?.trim() || "");
      if (!queryText) {
        await db.insertInto("simulation_run_candidate_sets").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: workUnit.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, candidates_json: "[]", stats_json: '{"reason":"empty-query"}', created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ updated_at: now } as any)).execute();
        continue;
      }

      try {
        const built = await computeCandidateSet({
          ports: {
            getEmbedding: async (text) => await getEmbedding(text),
            vectorQuery: async (embedding, query) => {
              const results = await (context.env as any).MOMENT_INDEX.query(embedding, { 
                topK: query.topK, 
                returnMetadata: true, 
                filter: { momentGraphNamespace: childRow._namespace } 
              });
              const matches = (results?.matches ?? []).map((m: any) => ({ id: m.id, score: m.score }));
              return { matches };
            },
            loadCandidateRowsById: async (ids) => {
              const rows = ids.length > 0 ? await fetchMomentsFromRun(context, input.runId, ids) : [];
              return new Map((rows as any[]).map(r => [r.id, r]));
            },
          },
          childMomentId: root.moment_id,
          childDocumentId: childRow.document_id,
          childCreatedAt: childRow.created_at,
          childSourceMetadata: childRow.source_metadata ?? undefined,
          childText: queryText,
          maxCandidates: 20,
          vectorTopK: 50,
        });

        await db.insertInto("simulation_run_candidate_sets").values({ run_id: input.runId, child_moment_id: root.moment_id, r2_key: workUnit.r2Key, stream_id: root.stream_id, macro_index: root.macro_index as any, candidates_json: JSON.stringify(built.candidates), stats_json: JSON.stringify(built.stats), created_at: now, updated_at: now }).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({ candidates_json: JSON.stringify(built.candidates), stats_json: JSON.stringify(built.stats), updated_at: now } as any)).execute();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log.error("item.error", { phase: "candidate_sets", childMomentId: root.moment_id, r2Key: workUnit.r2Key, error: msg });
        await db.updateTable("simulation_run_documents")
          .set({ error_json: JSON.stringify({ error: msg }) as any, updated_at: now })
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", workUnit.r2Key)
          .execute();
      }
    }

    // Mark doc as processed for this phase
    const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
    const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
    const nextPhases = [...new Set([...currentPhases, "candidate_sets"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextPhases as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  web: {
    routes: candidateSetsRoutes,
    ui: {
      drilldown: CandidateSetsCard,
    },
  },

  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "candidate_sets" }),
};

registerPipeline(candidate_sets_simulation);
