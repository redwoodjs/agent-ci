import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runMacroSynthesisForDocument, MacroSynthesisOutput } from "./engine/core/orchestrator";

export const MacroSynthesisPhase: Phase<string, MacroSynthesisOutput> = {
  name: "macro_synthesis",
  next: "macro_classification",
  execute: async (r2Key: string, context: PipelineContext) => {
    if (!context.simulation) {
        throw new Error("MacroSynthesisPhase requires simulation context");
    }

    // 1. Fetch dependencies from 'micro_batches' phase artifact
    const microBatchesArtifact = await context.simulation.getArtifact("micro_batches", r2Key);
    // Artifact shape: { batches: MicroBatch[], microMoments: MicroMoment[] }
    
    // Default to empty if not found (e.g. skipped phase or first run?)
    // In a real pipeline, micro_batches should have run.
    const plannedBatches = microBatchesArtifact?.batches || [];
    const microMoments = microBatchesArtifact?.microMoments || [];
    
    // 2. Compute defaults
    // TODO: Ideally fetch these from the source document or a 'ingest' artifact.
    // For now we use safe defaults.
    const defaultAuthor = "machinen";
    const defaultCreatedAt = new Date().toISOString(); 
    
    // 3. Execution
    return runMacroSynthesisForDocument({
        context,
        runId: context.simulation.runId,
        r2Key,
        plannedBatches,
        microMoments,
        macroSynthesisPromptContext: null, // TODO: Fetch from plugin/doc
        previousMicroStreamHash: null,     // TODO: Fetch from previous run artifact
        defaultAuthor,
        defaultCreatedAt,
        now: new Date().toISOString()
    });
  }
};
