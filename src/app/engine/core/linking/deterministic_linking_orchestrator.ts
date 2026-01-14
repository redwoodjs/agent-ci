import { computeDeterministicLinkingProposal } from "../../lib/phaseCores/deterministic_linking_core";
import { extractAnchorTokens } from "../../utils/anchorTokens";

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function readTimeRangeStartMs(value: unknown): number | null {
  const range = (value as any)?.timeRange;
  const start = range?.start;
  return parseTimeMs(start);
}

function computeMomentStartMs(input: {
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const rangeStart = readTimeRangeStartMs(input.sourceMetadata);
  if (rangeStart !== null) {
    return rangeStart;
  }
  return parseTimeMs(input.createdAt);
}

function parseIssueRefFromAnchors(anchors: unknown): string | null {
  if (!Array.isArray(anchors)) {
    return null;
  }
  for (const t of anchors) {
    if (typeof t !== "string") {
      continue;
    }
    if (/^#\d{1,10}$/.test(t)) {
      return t;
    }
  }
  return null;
}

function parseGithubRepoFromDocumentId(
  documentId: string
): { owner: string; repo: string } | null {
  const m = documentId.match(/^github\/([^/]+)\/([^/]+)\//);
  if (!m) {
    return null;
  }
  const owner = m[1] ?? "";
  const repo = m[2] ?? "";
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

export type DeterministicLinkingPorts = {
  resolveThreadHeadForDocumentAsOf: (input: {
    documentId: string;
    asOfMs: number | null;
  }) => Promise<{ headMomentId: string | null; anchorMomentId: string | null }>;
};

export async function computeDeterministicLinkingDecision(input: {
  ports: DeterministicLinkingPorts;
  r2Key: string;
  streamId: string;
  macroIndex: number;
  childMomentId: string;
  prevMomentId: string | null;
  childDocumentId: string;
  childCreatedAt: string;
  childSourceMetadata?: Record<string, any>;
  macroAnchors?: string[] | null;
  childTextForFallbackAnchors?: string | null;
}): Promise<{
  proposedParentId: string | null;
  audit: { kind: string; ruleId: string | null; evidence: Record<string, any> };
}> {
  let candidateIssueRef: string | null = parseIssueRefFromAnchors(
    input.macroAnchors
  );
  if (!candidateIssueRef && input.childTextForFallbackAnchors) {
    const tokens = extractAnchorTokens(input.childTextForFallbackAnchors, 24);
    candidateIssueRef = tokens.find((t) => /^#\d{1,10}$/.test(t)) ?? null;
  }

  let candidateParentMomentId: string | null = null;
  let candidateParentDocumentId: string | null = null;
  let matchedAnchorMomentId: string | null = null;

  if (input.macroIndex === 0 && candidateIssueRef) {
    const repo = parseGithubRepoFromDocumentId(input.childDocumentId);
    const issueNumber = candidateIssueRef.slice(1);
    if (repo && issueNumber) {
      const childStartMs =
        computeMomentStartMs({
          createdAt: input.childCreatedAt,
          sourceMetadata: input.childSourceMetadata,
        }) ?? null;
      const candidates = [
        `github/${repo.owner}/${repo.repo}/issues/${issueNumber}/latest.json`,
        `github/${repo.owner}/${repo.repo}/pull-requests/${issueNumber}/latest.json`,
      ];
      for (const docId of candidates) {
        const resolved = await input.ports.resolveThreadHeadForDocumentAsOf({
          documentId: docId,
          asOfMs: childStartMs,
        });
        if (resolved.headMomentId) {
          candidateParentMomentId = resolved.headMomentId;
          candidateParentDocumentId = docId;
          matchedAnchorMomentId = resolved.anchorMomentId;
          break;
        }
      }
    }
  }

  const proposal = computeDeterministicLinkingProposal({
    r2Key: input.r2Key,
    streamId: input.streamId,
    macroIndex: input.macroIndex,
    childMomentId: input.childMomentId,
    prevMomentId: input.prevMomentId,
    candidateParentMomentId,
    candidateIssueRef,
    candidateParentR2Key: candidateParentDocumentId,
  });
  if (matchedAnchorMomentId) {
    proposal.evidence.matchedAnchorMomentId = matchedAnchorMomentId;
  }

  return {
    proposedParentId: proposal.proposedParentId,
    audit: {
      kind: "deterministic_linking",
      ruleId: proposal.ruleId,
      evidence: proposal.evidence,
    },
  };
}

