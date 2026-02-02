import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runIngestDiffForKey, IngestDiffOutput } from "./engine/core/orchestrator";

// This is the shape of the artifact we stored in the previous run (if any).
// For ingest_diff, we might be the first phase, so we rely on what was in the DB
// or we treat "input" as the r2Key.
// Actually, in the Unified Runtime, the "input" for the first phase is usually the R2Key directly.
// But we might need "state" from previous runs?
// In legacy, we stored `ingest_diff_previous_etag`?
// In Unified, we should rely on `context.cache` or simpler, just the Artifact from the previous run execution?
// Ah, `ingest_diff` compares NEW head against OLD stored etag.
// So we need to fetch the LAST successful artifact for this r2Key/phase.

// NOTE: The standard `executePhase` loads `cached` for *this* input.
// That is for correct-caching (if we already ran this input, skip).
// But `ingest_diff` logic is "Look at the PREVIOUS time we ran this".
// The `ArtifactStorage` might support looking up "latest for key".

export const IngestDiffPhase: Phase<string, IngestDiffOutput> = {
  name: "ingest_diff",
  // If changed, go to next. If not, stop?
  // The Orchestrator handles "next". But we can conditionally decide.
  // Actually, Phase just returns output. If `changed` is false, maybe next phase filters it?
  // Or we use conditional next?
  // For now, let's just return the output. The orchestrator dispatches next.
  // We might need a filter in the transition strategy or the next phase itself checks changed?
  // In legacy, `ingest_diff` would ONLY enqueue micro_batches if changed.
  next: "micro_batches", 
  execute: async (r2Key: string, context: PipelineContext) => {
    // We need to find the PREVIOUS etag. 
    // In strict unified runtime, we might want `context.state.getLastSuccess(phase, r2Key)`?
    // For now, let's assume we can't easily get it without a DB query?
    // Actually, `Input` is just r2Key.
    
    // We can use the DB directly here for now to bridge gap.
    let previousEtag: string | null = null;
    if (context.indexingMode === 'indexing') { // Only live logic cares about diffs?
       // Actually simulation also cares?? No, simulation forces run usually?
       // Let's look at legacy runner logic.
    }
    
    // Legacy `loadPreviousEtag` queried `simulation_run_documents` (for Sim) or `indexing_state` (for Live).
    // In Unified Simulation, we have `simulation_run_artifacts`.
    // We can query that for the *previous* run? Or this run?
    // If it's a new run, we assume empty?
    
    // Wait, `ingest_diff` purpose is: "Has this document changed since the LAST time we indexed it?"
    
    // If we are in Simulation Loop:
    // Usually we just process everything given to us.
    // But `ingest_diff` might check if strict dedup is needed.
    // Legacy `ingest_diff/engine/simulation/runner.ts` actually checked `processed_phases_json`?
    // No, legacy `orchestrator.ts` used `loadPreviousEtag`.
    
    // Simplification: In Simulation, we typically treat everything as "changed" if it's a new Run? 
    // OR we check the source file.
    
    // Let's just implement the check.
    // We need access to the "Previous World State".
    // For Live: `indexing_state` table.
    // For Sim: The previous *committed* state? Or just always true?
    
    // In the spirit of "Simplification", let's make IngestDiff actually CHECK R2.
    // And for the "Previous", we might need a helper in Context?
    
    // Let's peek at `context.db` (MomentDatabase). 
    // It doesn't have `indexing_state` (that's separate DB).
    
    // HACK: for now, assume always changed if we can't find previous.
    // Ideally we inject a "PreviousStateProvider" in Context.
    
    return runIngestDiffForKey({
        context,
        r2Key,
        previousEtag: null // TODO: Hook up real previous state
    });
  },
};
