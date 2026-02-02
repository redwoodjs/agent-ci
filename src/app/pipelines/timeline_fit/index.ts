import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runTimelineFitForDocument } from "./engine/core/orchestrator";
import { MaterializeMomentsPhase } from "../materialize_moments";
import { CandidateSetsPhase } from "../candidate_sets";
import { addMoment } from "../../engine/databases/momentGraph";

export const TimelineFitPhase: Phase<string, any> = {
  name: "timeline_fit",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load moments from Phase 5
    const materializationOutput = await context.storage.load<any>(MaterializeMomentsPhase, r2Key);
    if (!materializationOutput) {
      throw new Error(`No materialize_moments output found for ${r2Key}. Timeline fit cannot proceed.`);
    }
    const moments = materializationOutput.moments || [];

    // 2. Load candidate sets from Phase 7
    const candidateSetsOutput = await context.storage.load<any>(CandidateSetsPhase, r2Key);
    const candidateSets = candidateSetsOutput?.candidateSets || {};

    // 3. Run Core Logic for each moment that needs a fit
    const results: Record<string, any> = {};
    const momentById = new Map(moments.map(m => [m.id, m]));

    for (const moment of moments) {
      const candidates = (candidateSets as Record<string, any>)[moment.id]?.candidates || [];
      if (candidates.length === 0) {
        continue;
      }

      // 4. Run "Judgement" Core Logic
      const decision = await runTimelineFitForDocument({
        context,
        childMoment: moment,
        candidates,
      });

      results[moment.id] = decision;

      // 5. Commit Final Link (Side Effect)
      if (decision.chosenParentId) {
        const originalMoment = momentById.get(moment.id);
        if (originalMoment) {
          await addMoment(
            {
              ...originalMoment,
              parentId: decision.chosenParentId,
              linkAuditLog: decision.audit,
            } as any,
            {
              env: context.env,
              momentGraphNamespace: context.momentGraphNamespace || null,
            }
          );
        }
      }
    }

    return { 
      decisionsCount: Object.keys(results).length,
      decisions: results 
    };
  },
};
