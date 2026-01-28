import { getSimulationDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { runMacroSynthesisAdapter } from "./adapter";
import { synthesizeMicroMomentsIntoStreams } from "../../../../engine/synthesis/synthesizeMicroMoments";
import { runStandardDocumentPolling } from "../../../../engine/simulation/orchestration";
import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { macroSynthesisRoutes } from "../../web/routes/outputs";
import { MacroOutputsCard } from "../../web/ui/MacroOutputsCard";
import { recoverMacroSynthesisZombies } from "./sweeper";

export const macro_synthesis_simulation: PipelineRegistryEntry = {
  phase: "macro_synthesis" as const,
  label: "Macro Synthesis",

  onTick: runStandardDocumentPolling({ phase: "macro_synthesis" }),

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

    const result = await runMacroSynthesisAdapter(context, {
      runId: input.runId,
      r2Keys: [workUnit.r2Key],
      now,
      log,
      ports: { synthesizeMicroMomentsIntoStreams },
    });

    if (result.failed > 0) {
      await db.updateTable("simulation_run_documents")
        .set({ error_json: JSON.stringify(result.failures) as any, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
    }

    // Mark doc as processed for this phase
    const doc = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
    const processed = (doc?.processed_phases_json || []) as string[];
    const nextProcessed = [...new Set([...processed, "macro_synthesis"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextProcessed as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", workUnit.r2Key)
      .execute();
  },

  web: {
    routes: macroSynthesisRoutes,
    ui: {
      drilldown: MacroOutputsCard,
    },
  },

  recoverZombies: recoverMacroSynthesisZombies,
};

registerPipeline(macro_synthesis_simulation);
