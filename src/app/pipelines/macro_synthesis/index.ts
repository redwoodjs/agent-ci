import { Phase, PipelineContext, Plugin, Document } from "../../engine/runtime/types";
import { computeMacroSynthesisForDocument } from "./engine/core/orchestrator";
import { runFirstMatchHook } from "../../engine/indexing/pluginPipeline";
import { MicroBatchesPhase } from "../micro_batches";

export const MacroSynthesisPhase: Phase<string, any> = {
  name: "macro_synthesis",
  next: "macro_classification",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Prepare Document
    const document = await runFirstMatchHook<Document>(
      context.plugins,
      (plugin: Plugin) => plugin.prepareSourceDocument?.(context)
    );

    if (!document) {
      throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
    }

    // 2. Load MicroBatches output
    const microOutput = await context.storage.load<any>(MicroBatchesPhase, r2Key);
    if (!microOutput) {
      throw new Error(`No micro_batches output found for ${r2Key}. Macro synthesis cannot proceed.`);
    }

    // 3. Run Core
    return await computeMacroSynthesisForDocument({
      document,
      context,
      plannedBatches: microOutput.batches || [],
      microMoments: microOutput.microMoments || [],
    });
  },
};
