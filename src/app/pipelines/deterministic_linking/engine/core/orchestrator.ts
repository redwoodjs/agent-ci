import { extractAnchorTokens } from "../../../../engine/utils/anchorTokens";
import { resolveThreadHeadForDocumentAsOf } from "../../../../engine/core/linking/explicitRefThreadHead";
import { PipelineContext } from "../../../../engine/runtime/types";
import { Moment } from "../../../../engine/types";
// -- types and helpers from core --

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
    input.candidateParentMomentId &&
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
  if (proposedParent) {
    ruleId = input.candidateIssueRef
      ? "explicit_issue_ref_thread_head"
      : "explicit_parent_hint";
    evidence.issueRef = input.candidateIssueRef;
    evidence.matchedParentDocumentId = input.candidateParentR2Key;
  }

  return { proposedParentId: proposedParent, ruleId, evidence };
}

// -- helpers from orchestrator --

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

function parseIssueNumberFromDocumentId(documentId: string): string | null {
  // Matches e.g. github/owner/repo/issues/123/latest.json or pull-requests/123/latest.json
  const m = documentId.match(/\/(?:issues|pull-requests)\/(\d+)\//);
  return m?.[1] ?? null;
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
  rawDocumentContent?: string | null;
  logger?: any;
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

  // Diagnostic: Log what we are working with
  if (input.rawDocumentContent && input.logger) {
    input.logger.info("deterministic-linking:internal", {
      childMomentId: input.childMomentId,
      r2Key: input.r2Key,
      corpusLength: input.rawDocumentContent.length,
      snippet: input.rawDocumentContent.slice(0, 200) + "..."
    });
  }

  // Fallback: Scan raw document content if provided
  if (!candidateIssueRef && input.rawDocumentContent) {
    const selfIssueNumber = parseIssueNumberFromDocumentId(input.childDocumentId);
    const selfRef = selfIssueNumber ? `#${selfIssueNumber}` : null;

    // Use global scan to find all potential candidates
    const matches = Array.from(input.rawDocumentContent.matchAll(/#(\d{1,10})/g));
    
    if (input.logger) {
      input.logger.info("deterministic-linking:internal:scan", {
        childMomentId: input.childMomentId,
        selfRef,
        totalMatches: matches.length,
        allMatches: matches.map(m => m[0])
      });
    }

    for (const match of matches) {
      const issueRef = match[0];
      if (selfRef && issueRef === selfRef) {
        if (input.logger) input.logger.info("deterministic-linking:diagnostic:skip-self", { childMomentId: input.childMomentId, issueRef });
        continue;
      }
      
      candidateIssueRef = issueRef;
      if (input.logger) input.logger.info("deterministic-linking:diagnostic:fallback-found", { childMomentId: input.childMomentId, candidateIssueRef });
      break; 
    }
  }

  // Diagnostic log for anchor extraction
  if (input.macroAnchors && input.macroAnchors.length > 0 && input.logger) {
    input.logger.info("deterministic-linking:diagnostic:anchors", { childMomentId: input.childMomentId, anchors: input.macroAnchors });
    if (candidateIssueRef) {
      input.logger.info("deterministic-linking:diagnostic:extracted", { childMomentId: input.childMomentId, candidateIssueRef });
    }
  }

  let candidateParentMomentId: string | null = null;
  let candidateParentDocumentId: string | null = null;
  let matchedAnchorMomentId: string | null = null;

  if (candidateIssueRef) {
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
          if (input.logger) {
            input.logger.info("deterministic-linking:diagnostic:resolved", {
                 childMomentId: input.childMomentId,
                 candidateIssueRef,
                 candidateParentMomentId,
                 docId
            });
          }
          break;
        } else {
          if (input.logger) {
             input.logger.info("deterministic-linking:diagnostic:failed-resolve", {
                 childMomentId: input.childMomentId,
                 candidateIssueRef,
                 docId
             });
          }
        }
      }
    } else {
      if (input.logger) {
         input.logger.info("deterministic-linking:diagnostic:parse-fail", { childMomentId: input.childMomentId, childDocumentId: input.childDocumentId, candidateIssueRef });
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

export async function runDeterministicLinkingForDocument(input: {
  r2Key: string;
  context: PipelineContext;
  moments: Moment[];
}): Promise<{
  decisions: Array<{
    childMomentId: string;
    proposedParentId: string | null;
    audit: any;
    streamId: string;
    macroIndex: number;
  }>;
}> {
  const { r2Key, context, moments } = input;
  const decisions: any[] = [];

  // Sort moments by stream and index to facilitate prevId lookup
  // Actually Phase 5 returns them in a sensible order, but let's be safe
  const momentByStreamAndIndex = new Map<string, Moment>();
  for (const m of moments) {
    const meta = m.sourceMetadata as any;
    const streamId = meta?.simulation?.streamId || "stream";
    const macroIndex = meta?.simulation?.macroIndex ?? 0;
    momentByStreamAndIndex.set(`${streamId}:${macroIndex}`, m);
  }

  // Optional: Fetch raw document content from R2 for fallback scanning
  let rawDocumentContent: string | null = null;
  try {
    const bucket = (context.env as any).MACHINEN_BUCKET;
    if (bucket) {
      const obj = await bucket.get(r2Key);
      if (obj) {
        const text = await obj.text();
        rawDocumentContent = text;
        if (context.logger) {
          context.logger.info("deterministic-linking:diagnostic:r2-fetch", { r2Key, length: text.length });
        }
      }
    }
  } catch (err) {
    if (context.logger) {
      context.logger.warn("deterministic-linking:diagnostic:r2-fetch-fail", { r2Key, error: err instanceof Error ? err.message : String(err) });
    }
  }

  for (const childMoment of moments) {
    const meta = childMoment.sourceMetadata as any;
    const streamId = meta?.simulation?.streamId || "stream";
    const macroIndex = meta?.simulation?.macroIndex ?? 0;

    const prevMomentId =
      macroIndex > 0
        ? momentByStreamAndIndex.get(`${streamId}:${macroIndex - 1}`)?.id ?? null
        : null;

    const decision = await computeDeterministicLinkingDecision({
      ports: {
        resolveThreadHeadForDocumentAsOf: async (args) => {
          return resolveThreadHeadForDocumentAsOf({
            ...args,
            context: {
              env: context.env,
              momentGraphNamespace: context.momentGraphNamespace || null,
            },
          });
        },
      },
      logger: context.logger,
      r2Key,
      streamId,
      macroIndex,
      childMomentId: childMoment.id,
      prevMomentId,
      childDocumentId: childMoment.documentId,
      childCreatedAt: childMoment.createdAt,
      childSourceMetadata: childMoment.sourceMetadata || {},
      macroAnchors: childMoment.anchors || [], // anchors might have been added in classification
      childTextForFallbackAnchors: `${childMoment.title || ""}\n${
        childMoment.summary || ""
      }`,
      rawDocumentContent,
    });

    decisions.push({
      childMomentId: childMoment.id,
      proposedParentId: decision.proposedParentId,
      audit: decision.audit,
      streamId,
      macroIndex,
    });
  }

  return { decisions };
}
