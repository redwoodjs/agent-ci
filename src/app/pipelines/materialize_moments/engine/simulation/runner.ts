import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import {
  getMomentGraphDb,
  getSimulationDb,
} from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { runMaterializeMomentsAdapter } from "./adapter";
import { applyMomentGraphNamespacePrefixValue } from "../../../../engine/momentGraphNamespace";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";

export const materialize_moments_simulation: PipelineRegistryEntry = {
  phase: "materialize_moments" as const,
  label: "Materialize Moments",

  onTick: runStandardDocumentPolling({ phase: "materialize_moments" }),

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

    const runRow = await db
      .selectFrom("simulation_runs")
      .select([
        "moment_graph_namespace",
        "moment_graph_namespace_prefix",
      ])
      .where("run_id", "=", input.runId)
      .executeTakeFirst();

    if (!runRow) return;

    const baseNamespace = runRow.moment_graph_namespace;
    const prefix = runRow.moment_graph_namespace_prefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(baseNamespace, prefix);

    // Granular execution
    const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

    const result = await runMaterializeMomentsAdapter(context, {
      runId: input.runId,
      r2Keys: [workUnit.r2Key],
      effectiveNamespace: effectiveNamespace ?? null,
      momentDb,
      now,
      log,
    });

    const errorJson = result.failed > 0 ? JSON.stringify(result.failures) : null;

    // Mark doc as processed for this phase
    const docMetadata = await db
      .selectFrom("simulation_run_documents")
      .select("processed_phases_json")
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .executeTakeFirst();
    
    const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
    const nextPhases = [...new Set([...currentPhases, "materialize_moments"])];
    
    await db
      .updateTable("simulation_run_documents")
      .set({
        processed_phases_json: nextPhases as any,
        error_json: errorJson as any,
        updated_at: now,
      })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  async recoverZombies(context, input) {
    // Standard recovery
  }
};

registerPipeline(materialize_moments_simulation);
