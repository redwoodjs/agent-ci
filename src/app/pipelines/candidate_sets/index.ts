import { Phase, PipelineContext, Moment } from "../../engine/runtime/types";
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
    const moments = (materializationOutput.moments as Moment[]) || [];

    // 2. Load linking decisions from Phase 6
    const linkingOutput = await context.storage.load<any>(DeterministicLinkingPhase, r2Key);
    const linkingDecisions = new Map<string, any>(
      (linkingOutput?.decisions || []).map((d: any) => [d.childMomentId, d])
    );

    // 3. Run Core Logic for each moment that needs candidates
    const results: Record<string, any> = {};

    for (const moment of moments) {
      const linked = linkingDecisions.get(moment.id);
      if (linked && linked.proposedParentId) {
        continue;
      }

      const candidateSet = await runCandidateSetComputation({
        context,
        childMoment: moment,
        maxCandidates: 10,
      });

      results[moment.id] = candidateSet;
    }

    return { candidateSets: results };
  },
};
