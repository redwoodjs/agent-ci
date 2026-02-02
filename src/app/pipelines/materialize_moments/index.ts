import { Phase, PipelineContext } from "../../engine/runtime/types";
import { materializeMomentsForDocument } from "./engine/core/orchestrator";
import { MacroClassificationPhase } from "../macro_classification";
import { runFirstMatchHook } from "../../engine/indexing/pluginPipeline";
import { addMoment } from "../../engine/databases/momentGraph";

export const MaterializeMomentsPhase: Phase<string, any> = {
  name: "materialize_moments",
  next: "deterministic_linking",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load output from previous phase
    const classificationOutput = await context.storage.load<any>(MacroClassificationPhase, r2Key);
    if (!classificationOutput) {
      throw new Error(`No macro_classification output found for ${r2Key}. Materialization cannot proceed.`);
    }

    // 2. Prepare Document (to get metadata)
    const document = await runFirstMatchHook(
      context.plugins,
      "prepareSourceDocument",
      (plugin) => plugin.prepareSourceDocument?.(context)
    );

    if (!document) {
      throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
    }

    // 3. Run Core Logic
    const runId = (context.env as any).SIMULATION_RUN_ID || "live";
    const { moments } = await materializeMomentsForDocument({
      document,
      context,
      runId,
      r2Key,
      now: new Date().toISOString(),
      streams: classificationOutput.streams || [],
    });

    // 4. Commit results to Database (Side Effect)
    for (const moment of moments) {
      await addMoment(moment, {
        env: context.env,
        momentGraphNamespace: context.momentGraphNamespace || null,
      });
    }

    return { momentsMaterialized: moments.length, moments };
  },
};
