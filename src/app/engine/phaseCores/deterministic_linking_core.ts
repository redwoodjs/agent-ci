export type DeterministicLinkingProposal = {
  proposedParentId: string | null;
  ruleId: string | null;
  evidence: Record<string, any>;
};

export function computeDeterministicLinkingProposal(input: {
  r2Key: string;
  streamId: string;
  macroIndex: number;
  childMomentId: string;
  prevMomentId: string | null;
  candidateParentMomentId: string | null;
  candidateIssueRef: string | null;
  candidateParentR2Key: string | null;
}): DeterministicLinkingProposal {
  const proposedParent =
    input.macroIndex > 0
      ? input.prevMomentId
      : input.candidateParentMomentId &&
        input.candidateParentMomentId !== input.childMomentId
      ? input.candidateParentMomentId
      : null;

  const evidence: Record<string, any> = {
    phase: "deterministic_linking",
    r2Key: input.r2Key,
    streamId: input.streamId,
    macroIndex: input.macroIndex,
    proposedParent,
  };

  let ruleId: string | null = null;
  if (input.macroIndex > 0) {
    ruleId = "within_stream_chain";
  } else if (proposedParent) {
    ruleId = "run_r2key_issue_ref";
    evidence.issueRef = input.candidateIssueRef;
    evidence.matchedParentR2Key = input.candidateParentR2Key;
  }

  return { proposedParentId: proposedParent, ruleId, evidence };
}

