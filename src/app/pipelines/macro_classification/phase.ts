import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runMacroClassificationForDocument, MacroClassificationOutput } from "./engine/core/orchestrator";

export const MacroClassificationPhase: Phase<string, MacroClassificationOutput> = {
  name: "macro_classification",
  next: "materialize_moments",
  execute: async (r2Key: string, context: PipelineContext) => {
    if (!context.simulation) {
        throw new Error("MacroClassificationPhase requires simulation context");
    }

    // 1. Fetch dependencies from 'macro_synthesis' phase
    const synthesisArtifact = await context.simulation.getArtifact("macro_synthesis", r2Key);
    const streams = synthesisArtifact?.streams || [];

    const gating = {
        macroMaxPerStream: 12,
        macroMinImportance: 0,
        noisePatternStringsFromEnv: [],
        discordNoisePatternStringsFromEnv: []
    };
    
    // 2. Execution
    return runMacroClassificationForDocument({
        context,
        documentId: r2Key, // Using r2Key as docId in simplified flow
        streams,
        gating
    });
  }
};
