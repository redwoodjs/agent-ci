import { computeTimelineFitDecision } from "../../../../engine/core/linking/timelineFitOrchestrator";
import { PipelineContext } from "../../../../engine/runtime/types";
import { Moment } from "../../../../engine/types";

export async function runTimelineFitForDocument(input: {
  context: PipelineContext;
  childMoment: Moment;
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string;
    title: string | null;
    summary: string | null;
  }>;
}): Promise<{
  chosenParentId: string | null;
  decisions: any[];
  audit: any;
}> {
  const { context, childMoment, candidates } = input;
  
  const childText = `${childMoment.title || ""}\n${childMoment.summary || ""}`.trim();

  const proposal = await computeTimelineFitDecision({
    ports: { 
      callLLM: (prompt) => context.llm.call(prompt, "slow-reasoning", { temperature: 0 }) 
    },
    childMomentId: childMoment.id,
    childText,
    candidates,
    useLlmVeto: true,
    maxAnchorTokens: 24,
    maxSharedAnchorTokens: 12,
  });

  const audit = {
    kind: "timeline_fit",
    ruleId: "anchor_token_fit",
    evidence: {
      chosenParentId: proposal.chosenParentId,
      decisions: proposal.decisions,
      stats: proposal.stats,
      veto: proposal.veto,
    },
  };

  return {
    chosenParentId: proposal.chosenParentId,
    decisions: proposal.decisions,
    audit,
  };
}
