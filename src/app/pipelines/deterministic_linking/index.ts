import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runDeterministicLinkingForDocument } from "./engine/core/orchestrator";
import { MaterializeMomentsPhase } from "../materialize_moments";
import { addMoment } from "../../engine/databases/momentGraph";

export const DeterministicLinkingPhase: Phase<string, any> = {
  name: "deterministic_linking",
  next: "candidate_sets",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Load output from previous phase
    const materializationOutput = await context.storage.load<any>(MaterializeMomentsPhase, r2Key);
    if (!materializationOutput) {
      throw new Error(`No materialize_moments output found for ${r2Key}. Linking cannot proceed.`);
    }

    const moments = materializationOutput.moments || [];

    // 2. Run Core Logic
    const { decisions } = await runDeterministicLinkingForDocument({
      r2Key,
      context,
      moments,
    });

    // 3. Commit Linked Moments (Side Effect)
    // We only need to update moments that actually got a parent or an audit
    const momentById = new Map(moments.map(m => [m.id, m]));
    
    for (const decision of decisions) {
      const originalMoment = momentById.get(decision.childMomentId);
      if (!originalMoment) continue;

      // Update the moment in the graph with its parent and audit
      await addMoment(
        {
          ...originalMoment,
          parentId: decision.proposedParentId || undefined,
          linkAuditLog: decision.audit,
        },
        {
          env: context.env,
          momentGraphNamespace: context.momentGraphNamespace || null,
        }
      );
    }

    return { decisionsCount: decisions.length, decisions };
  },
};
