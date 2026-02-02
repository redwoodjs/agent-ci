import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runCandidateSetComputation } from "./engine/core/orchestrator";
import { MaterializeMomentsPhase } from "../materialize_moments";
import { DeterministicLinkingPhase } from "../deterministic_linking";

export const CandidateSetsPhase: Phase<string, any> = {
  name: "candidate_sets",
  next: "timeline_fit",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load moments from Phase 5
    const materializationOutput = await context.storage.load<any>(MaterializeMomentsPhase, r2Key);
    if (!materializationOutput) {
      throw new Error(`No materialize_moments output found for ${r2Key}. Candidate sets cannot proceed.`);
    }
    const moments = materializationOutput.moments || [];

    // 2. Load decisions from Phase 6
    const linkingOutput = await context.storage.load<{ decisions: any[] }>(DeterministicLinkingPhase, r2Key);
    const linkingDecisions = new Map<string, any>(
      (linkingOutput?.decisions || []).map((d: any) => [d.childMomentId, d])
    );

    // 3. Identify moments needing candidates
    const results: Record<string, any> = {};
    for (const moment of moments) {
      const decision = linkingDecisions.get(moment.id);
      
      // If it already has a deterministic parent, we skip candidate set generation
      if (decision?.proposedParentId) {
        continue;
      }

      // 4. Run Core Logic for this moment
      const candidateSet = await runCandidateSetComputation({
        context,
        childMoment: moment,
        maxCandidates: 20,
        vectorTopK: 50
      });

      results[moment.id] = candidateSet;
    }

    return { 
      candidateSetsCount: Object.keys(results).length,
      candidateSets: results 
    };
  },
};
