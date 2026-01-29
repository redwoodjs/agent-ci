import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { runMacroClassificationAdapter } from "./adapter";
import { callLLM } from "../../../../engine/utils/llm";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";
import { macroClassificationRoutes } from "../../web/routes/classifications";
import { MacroClassificationsCard } from "../../web/ui/MacroClassificationsCard";
import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";

export const macro_classification_simulation: PipelineRegistryEntry = {
  phase: "macro_classification" as const,
  label: "Macro Classification",

  onTick: runStandardDocumentPolling({ phase: "macro_classification" }),

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

    const result = await runMacroClassificationAdapter(context, {
      runId: input.runId,
      r2Keys: [workUnit.r2Key],
      now,
      log,
      ports: {
        callLLM: async (prompt) =>
          await callLLM(prompt, "slow-reasoning", { temperature: 0 }),
      },
    });

    if (result.failed > 0) {
      await db.updateTable("simulation_run_documents")
        .set({ error_json: JSON.stringify(result.failures) as any, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
    }

    // Mark doc as processed for this phase
    const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
    const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
    const nextPhases = [...new Set([...currentPhases, "macro_classification"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextPhases as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  web: {
    routes: macroClassificationRoutes,
    ui: {
      drilldown: MacroClassificationsCard,
    },
  },

  recoverZombies: (context, input) => recoverZombiesForPhase(context, { ...input, phase: "macro_classification" }),
};

registerPipeline(macro_classification_simulation);
