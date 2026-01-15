import { computeTimelineFitProposalDeep } from "../../lib/phaseCores/timeline_fit_deep_core";
import { extractAnchorTokens } from "../../utils/anchorTokens";

export type TimelineFitPorts = {
  callLLM?: (prompt: string) => Promise<string>;
};

export async function computeTimelineFitDecision(input: {
  ports: TimelineFitPorts;
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
    Number.isFinite(input.maxSharedAnchorTokens) &&
    input.maxSharedAnchorTokens > 0
      ? Math.floor(input.maxSharedAnchorTokens)
      : 12;

  const llmVeto =
    input.useLlmVeto && input.ports.callLLM
      ? async (llmInput: {
          childText: string;
          candidates: Array<{
            id: string;
            title: string | null;
            summary: string | null;
          }>;
        }) => {
          const prompt =
            `Given a child moment and candidate parent moments, return a JSON object:\n` +
            `{"vetoedIds":["..."],"note":"..."}\n\n` +
            `Child:\n${llmInput.childText}\n\n` +
            `Candidates:\n` +
            llmInput.candidates
              .map(
                (c) =>
                  `- id=${c.id}\n  title=${c.title ?? ""}\n  summary=${
                    c.summary ?? ""
                  }`
              )
              .join("\n\n");
          try {
            const raw = await input.ports.callLLM!(prompt);
            const parsed = JSON.parse(raw);
            const vetoedIds = Array.isArray(parsed?.vetoedIds)
              ? parsed.vetoedIds.filter((x: any) => typeof x === "string")
              : [];
            const note = typeof parsed?.note === "string" ? parsed.note : null;
            return { vetoedIds, note };
          } catch {
            return { vetoedIds: [], note: null };
          }
        }
      : undefined;

  const proposal = await computeTimelineFitProposalDeep({
    childMomentId: input.childMomentId,
    childText: input.childText,
    candidates: input.candidates,
    extractAnchorTokens,
    maxAnchorTokens,
    maxSharedAnchorTokens,
    useLlmVeto: input.useLlmVeto,
    llmVeto,
  });

  return {
    chosenParentId: proposal.chosenParentId,
    decisions: proposal.decisions,
    stats: { candidateCount: proposal.candidateCount },
    veto: proposal.veto ?? null,
  };
}
