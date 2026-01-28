import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { fetchMomentsFromRun } from "../../../../engine/simulation/runArtifacts";
import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";
import { deterministicLinkingRoutes } from "../../web/routes/link-decisions";
import { LinkDecisionsCard } from "../../web/ui/LinkDecisionsCard";
import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";
import { addMoment } from "../../../../engine/databases/momentGraph";
import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";

export const deterministic_linking_simulation: PipelineRegistryEntry = {
  phase: "deterministic_linking" as const,
  label: "Deterministic Linking",

  onTick: runStandardDocumentPolling({ phase: "deterministic_linking" }),

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

    const runRow = await db.selectFrom("simulation_runs").select(["moment_graph_namespace", "moment_graph_namespace_prefix"]).where("run_id", "=", input.runId).executeTakeFirst();
    if (!runRow) return;

    const baseNamespace = runRow.moment_graph_namespace;
    const prefix = runRow.moment_graph_namespace_prefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(baseNamespace, prefix);

    // Granular execution
    const roots = await db.selectFrom("simulation_run_materialized_moments").select(["moment_id", "r2_key", "stream_id", "macro_index"]).where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).execute();
    const rootIds = roots.map(r => r.moment_id);
    const moments = await fetchMomentsFromRun(context, input.runId, rootIds);
    const rootById = new Map((moments as any[]).map(r => [r.id, r]));

    for (const root of roots) {
      const childRow = rootById.get(root.moment_id);
      if (!childRow) continue;

      try {
        // Find previous moment in stream
        const prevRow = await db.selectFrom("simulation_run_materialized_moments")
            .select("moment_id")
            .where("run_id", "=", input.runId)
            .where("stream_id", "=", root.stream_id)
            .where("macro_index", "=", (root.macro_index as number) - 1)
            .executeTakeFirst();
            
        const decision = await computeDeterministicLinkingDecision({
          ports: {
            resolveThreadHeadForDocumentAsOf: async (args) => {
               return resolveThreadHeadForDocumentAsOf({
                   ...args,
                   context: { env: context.env, momentGraphNamespace: effectiveNamespace ?? null }
               });
            }
          },
          r2Key: workUnit.r2Key,
          streamId: root.stream_id,
          macroIndex: root.macro_index as number,
          childMomentId: root.moment_id,
          prevMomentId: prevRow?.moment_id ?? null,
          childDocumentId: childRow.documentId,
          childCreatedAt: childRow.createdAt,
          childSourceMetadata: childRow.sourceMetadata,
          macroAnchors: childRow.anchors ?? [],
          childTextForFallbackAnchors: `${childRow.title || ''}\n${childRow.summary || ''}`, 
        });

        if (decision.proposedParentId) {
             const momentGraphContext = { env: context.env, momentGraphNamespace: effectiveNamespace ?? null };
             await addMoment({
                 ...childRow,
                 parentId: decision.proposedParentId,
                 linkAuditLog: decision.audit
             } as any, momentGraphContext);
        }

        await db.insertInto("simulation_run_link_decisions").values({
          run_id: input.runId,
          child_moment_id: root.moment_id,
          r2_key: workUnit.r2Key,
          stream_id: root.stream_id,
          macro_index: root.macro_index as any,
          decision: decision.proposedParentId ? "link" : "none",
          evidence_json: JSON.stringify(decision.audit),
          created_at: now,
          updated_at: now,
        } as any).onConflict(oc => oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
          decision: decision.proposedParentId ? "link" : "none",
          evidence_json: JSON.stringify(decision.audit),
          updated_at: now,
        } as any)).execute();
        
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await log.error("item.error", { phase: "deterministic_linking", childMomentId: root.moment_id, r2Key: workUnit.r2Key, error: msg });
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
    const nextPhases = [...new Set([...currentPhases, "deterministic_linking"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextPhases as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  web: {
    routes: deterministicLinkingRoutes,
    ui: {
      drilldown: LinkDecisionsCard,
    },
  },

  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "deterministic_linking" }),
};

registerPipeline(deterministic_linking_simulation);
