import { computeTimelineFitProposalDeep } from "../phaseCores/timeline_fit_deep_core";
import { extractAnchorTokens } from "../utils/anchorTokens";

export type PhaseGPorts = {
  llmVeto?: (input: {
    childText: string;
    candidates: Array<{ id: string; title: string | null; summary: string | null }>;
  }) => Promise<{ vetoedIds: string[]; note?: string | null }>;
};

export async function computePhaseGTimelineFitDecision(input: {
  ports: PhaseGPorts;
  childMomentId: string;
  childText: string;
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string | null;
    title: string | null;
    summary: string | null;
  }>;
  useLlmVeto: boolean;
  maxAnchorTokens: number;
  maxSharedAnchorTokens: number;
}): Promise<{
  chosenParentId: string | null;
  decisions: any[];
  stats: { candidateCount: number };
  veto?: { vetoedIds: string[]; note?: string | null } | null;
}> {
  const maxAnchorTokens =
    Number.isFinite(input.maxAnchorTokens) && input.maxAnchorTokens > 0
      ? Math.floor(input.maxAnchorTokens)
      : 24;
  const maxSharedAnchorTokens =
    Number.isFinite(input.maxSharedAnchorTokens) && input.maxSharedAnchorTokens > 0
      ? Math.floor(input.maxSharedAnchorTokens)
      : 12;

  const proposal = await computeTimelineFitProposalDeep({
    childMomentId: input.childMomentId,
    childText: input.childText,
    candidates: input.candidates,
    extractAnchorTokens,
    maxAnchorTokens,
    maxSharedAnchorTokens,
    useLlmVeto: input.useLlmVeto,
    llmVeto: input.useLlmVeto ? input.ports.llmVeto : undefined,
  });

  return {
    chosenParentId: proposal.chosenParentId,
    decisions: proposal.decisions,
    stats: { candidateCount: proposal.candidateCount },
    veto: proposal.veto ?? null,
  };
}

