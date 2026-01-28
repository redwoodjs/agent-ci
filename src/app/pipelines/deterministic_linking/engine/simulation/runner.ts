import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { addMoment } from "../../../../engine/databases/momentGraph";
import { fetchMomentsFromRun } from "../../../../engine/simulation/runArtifacts";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { computeDeterministicLinkingDecision } from "../../../../engine/core/linking/deterministicLinkingOrchestrator";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";

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

    // Granular execution
    const matRows = await db.selectFrom("simulation_run_materialized_moments")
        .select(["moment_id", "stream_id", "macro_index"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();

    const momentIds = matRows.map(r => r.moment_id);
    const moments = await fetchMomentsFromRun(context, input.runId, momentIds);
    const momentsById = new Map((moments as any[]).map(m => [m.id, m]));
    
    try {
      for (const row of matRows) {
        const childRaw = momentsById.get(row.moment_id);
        if (!childRaw) continue;

        const child = {
            ...childRaw,
            id: childRaw.id,
            documentId: childRaw.document_id,
            createdAt: childRaw.created_at,
            sourceMetadata: childRaw.source_metadata
        };

        const momentGraphContext = { env: context.env, momentGraphNamespace: childRaw._namespace };
        const childText = `${childRaw.title || ""} ${childRaw.summary || ""}`;

        const proposal = await computeDeterministicLinkingDecision({
          ports: {
            resolveThreadHeadForDocumentAsOf: async (args) => {
              return await resolveThreadHeadForDocumentAsOf({
                documentId: args.documentId,
                asOfMs: args.asOfMs,
                context: momentGraphContext
              });
            }
          },
          r2Key: workUnit.r2Key,
          streamId: row.stream_id,
          macroIndex: row.macro_index as any,
          childMomentId: child.id,
          prevMomentId: null,
          childDocumentId: child.documentId,
          childCreatedAt: child.createdAt,
          childSourceMetadata: child.sourceMetadata,
          childTextForFallbackAnchors: childText,
          macroAnchors: null,
        });

        if (proposal.proposedParentId) {
           await addMoment({
             ...child,
             parentId: proposal.proposedParentId,
             linkAuditLog: proposal.audit,
           } as any, momentGraphContext);
        }
        
        const outcome = proposal.proposedParentId ? "attached" : "no_candidate";

        await db
          .insertInto("simulation_run_link_decisions")
          .values({
            run_id: input.runId,
            child_moment_id: row.moment_id,
            r2_key: workUnit.r2Key,
            stream_id: row.stream_id,
            macro_index: row.macro_index as any,
            phase: "deterministic_linking",
            outcome: outcome,
            rule_id: proposal.audit.ruleId ?? null,
            parent_moment_id: proposal.proposedParentId ?? null,
            evidence_json: proposal.audit.evidence ? JSON.stringify(proposal.audit.evidence) : null,
            created_at: now,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
              outcome: outcome,
              rule_id: proposal.audit.ruleId ?? null,
              parent_moment_id: proposal.proposedParentId ?? null,
              evidence_json: proposal.audit.evidence ? JSON.stringify(proposal.audit.evidence) : null,
              updated_at: now,
            } as any)
          )
          .execute();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", { phase: "deterministic_linking", r2Key: workUnit.r2Key, error: msg });
      await db.updateTable("simulation_run_documents")
        .set({ error_json: JSON.stringify({ error: msg }) as any, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
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

  async recoverZombies(context, input) {
    // Standard recovery
  }
};

registerPipeline(deterministic_linking_simulation);
