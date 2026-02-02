import { Phase, PipelineContext, Plugin, Document } from "../../engine/runtime/types";
import { runMacroClassification } from "./engine/core/orchestrator";
import { MacroSynthesisPhase } from "../macro_synthesis";
import { runFirstMatchHook } from "../../engine/indexing/pluginPipeline";

export const MacroClassificationPhase: Phase<string, any> = {
  name: "macro_classification",
  next: "materialize_moments",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load output from previous phase
    const macroSynthesisOutput = await context.storage.load<any>(MacroSynthesisPhase, r2Key);
    if (!macroSynthesisOutput) {
      throw new Error(`No macro_synthesis output found for ${r2Key}. Classification cannot proceed.`);
    }

    // 2. Prepare Document
    const document = await runFirstMatchHook<Document>(
      context.plugins,
      (plugin: Plugin) => plugin.prepareSourceDocument?.(context)
    );

    if (!document) {
      throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
    }

    // 3. Run Core Logic
    const result = await runMacroClassification({
      document,
      context,
      streams: macroSynthesisOutput.streams || [],
    });

    return result;
  },
};
