import { Phase, PipelineContext } from "../../engine/runtime/types";
import { computeMacroSynthesisForDocument } from "./engine/core/orchestrator";
import { MicroBatchesPhase } from "../micro_batches";
import { runFirstMatchHook } from "../../engine/indexing/pluginPipeline";

export const MacroSynthesisPhase: Phase<string, any> = {
  name: "macro_synthesis",
  next: "macro_classification",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load context from previous phase
    const microBatchesOutput = await context.storage.load<any>(MicroBatchesPhase, r2Key);
    if (!microBatchesOutput) {
      throw new Error(`No micro_batches output found for ${r2Key}. Macro synthesis cannot proceed.`);
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
    const result = await computeMacroSynthesisForDocument({
      document,
      context,
      plannedBatches: microBatchesOutput.batches || [],
      microMoments: microBatchesOutput.microMoments || [],
    });

    return result;
  },
};
