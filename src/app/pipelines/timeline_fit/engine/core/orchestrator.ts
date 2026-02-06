import { extractAnchorTokens } from "../../../../engine/utils/anchorTokens";
import { findAncestors } from "../../../../engine/databases/momentGraph";
import { parseLLMJson } from "../../../../engine/utils/llm";

// -- types and logic from core --

export type TimelineFitDecision = {
  candidateId: string;
  score: number | null;
  selected: boolean;
  rejected?: boolean;
  rejectReason?: string;
  rank?: number;
  details?: {
    sharedAnchorTokens: string[];
    isPredecessor?: boolean;
    semanticScore?: number;
    timeDeltaMs?: number;
    reasoning?: string;
    ancestry?: Array<{ title: string; summary: string }>;
  };
  title?: string | null;
  summary?: string | null;
};

export type TimelineFitDeepCandidate = {
  id: string;
  score: number | null;
  documentId: string | null;
  title: string | null;
  summary: string | null;
  createdAt: string;
  sourceMetadata?: any;
  isPredecessor?: boolean;
};

export async function computeTimelineFitProposalDeep(input: {
  childMomentId: string;
  childText: string;
  childTimestamp: string;
  candidates: TimelineFitDeepCandidate[];
  extractAnchorTokens: (text: string, maxTokens: number) => string[];
  maxAnchorTokens: number;
  maxSharedAnchorTokens: number;
  llmSelector?: (input: {
    childText: string;
    childTimestamp: string;
    candidates: Array<{ 
      id: string; 
      title: string | null; 
      summary: string | null; 
      relativeTime: string;
      ancestry: Array<{ title: string; summary: string }>;
    }>;
  }) => Promise<{ selectedId: string | null; note?: string | null }>;
  findAncestors?: (momentId: string) => Promise<Moment[]>;
  logger?: any;
}): Promise<{
  candidateCount: number;
  chosenParentId: string | null;
  decisions: TimelineFitDecision[];
  selectorResult?: { selectedId: string | null; note?: string | null } | null;
}> {
  const candidates = Array.isArray(input.candidates) ? input.candidates : [];
  const candidateCount = candidates.length;
  if (candidateCount === 0) {
    return { candidateCount, chosenParentId: null, decisions: [], selectorResult: null };
  }

  const childTokens = input.extractAnchorTokens(
    input.childText,
    input.maxAnchorTokens
  );
  const childSet = new Set(childTokens);
  const childTimeMs = Date.parse(input.childTimestamp);

  const ranked = candidates
    .map((c) => {
      const parentText = `${c.title ?? ""}\n${c.summary ?? ""}`.trim();
      const parentTokens = input.extractAnchorTokens(
        parentText,
        input.maxAnchorTokens
      );
      const shared: string[] = [];
      for (const t of parentTokens) {
        if (childSet.has(t)) {
          shared.push(t);
          if (shared.length >= input.maxSharedAnchorTokens) {
            break;
          }
        }
      }

      // Check for time inversion
      const parentCreatedAt = (c as any).createdAt || (c as any).sourceMetadata?.createdAt; // Fallback if not in row
      const parentTimeMs = parentCreatedAt ? Date.parse(parentCreatedAt) : null;
      const inverted = parentTimeMs !== null && !isNaN(childTimeMs) && parentTimeMs > childTimeMs;

      return { c, shared, inverted, parentTimeMs };
    })
    .sort((a, b) => {
      // 1. Priority to Predecessor
      if (a.c.isPredecessor !== b.c.isPredecessor) {
        return a.c.isPredecessor ? -1 : 1;
      }
      // 2. Priority to Anchor Matches
      const aShared = a.shared.length;
      const bShared = b.shared.length;
      if (aShared !== bShared) {
        return bShared - aShared;
      }
      // 3. Vector Score
      const aScore = typeof a.c.score === "number" ? a.c.score : -1;
      const bScore = typeof b.c.score === "number" ? b.c.score : -1;
      if (aScore !== bScore) {
        return bScore - aScore;
      }
      return a.c.id.localeCompare(b.c.id);
    });

  // Shortlist top 10 non-inverted candidates
  const shortlist = ranked.filter(r => !r.inverted).slice(0, 10);

  // Fetch Ancestry for shortlist
  const ancestryMap = new Map<string, Array<{ title: string; summary: string }>>();
  if (input.findAncestors) {
    for (const r of shortlist) {
      try {
        const ancestors = await input.findAncestors(r.c.id);
        ancestryMap.set(r.c.id, ancestors
          .filter(a => a.id !== input.childMomentId) // Prevent circularity: child cannot be its own ancestor
          .slice(0, 5)
          .map(m => ({
            title: m.title,
            summary: m.summary
          })));
      } catch (err) {
        if (input.logger) input.logger.warn("timeline-fit:ancestry-fail", { id: r.c.id, error: err });
      }
    }
  }

  let selectorResult: { selectedId: string | null; note?: string | null } | null = null;
  if (shortlist.length > 0 && input.llmSelector) {
    selectorResult = await input.llmSelector({
      childText: input.childText,
      childTimestamp: input.childTimestamp,
      candidates: shortlist.map((r) => {
        const timeGapMs = !isNaN(childTimeMs) && r.parentTimeMs !== null ? childTimeMs - r.parentTimeMs : null;
        const relativeTime = timeGapMs !== null ? `${Math.floor(timeGapMs / 60000)} mins` : "unknown time";
        return {
          id: r.c.id,
          title: r.c.title ?? null,
          summary: r.c.summary ?? null,
          relativeTime,
          ancestry: ancestryMap.get(r.c.id) || []
        };
      }),
    });
  }

  const chosenParentId = selectorResult?.selectedId || null;
  const decisions: TimelineFitDecision[] = [];

  for (let i = 0; i < ranked.length; i++) {
    const entry = ranked[i]!;
    const id = entry.c.id;
    const isSelf = id === input.childMomentId;
    const isSelected = id === chosenParentId;
    const isRejected = entry.inverted || (!isSelected && chosenParentId !== null) || (chosenParentId === null && !isSelf);
    
    decisions.push({
      candidateId: id,
      score: typeof entry.c.score === "number" ? entry.c.score : null,
      selected: isSelected,
      rejected: isRejected,
      rejectReason: entry.inverted ? "time-inversion" : isSelf ? "self" : undefined,
      rank: i + 1,
      details: {
        sharedAnchorTokens: entry.shared,
        isPredecessor: entry.c.isPredecessor,
        reasoning: isSelected ? selectorResult?.note || undefined : undefined,
        ancestry: ancestryMap.get(id)
      },
      title: entry.c.title ?? null,
      summary: entry.c.summary ?? null,
    });
  }

  return { candidateCount, chosenParentId, decisions, selectorResult };
}

export type TimelineFitPorts = {
  callLLM?: (prompt: string) => Promise<string>;
};

export async function computeTimelineFitDecision(input: {
  ports: TimelineFitPorts;
  childMomentId: string;
  childText: string;
  childTimestamp: string;
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string | null;
    title: string | null;
    summary: string | null;
    createdAt: string;
    isPredecessor?: boolean;
  }>;
  useLlmSelector: boolean;
  maxAnchorTokens: number;
  maxSharedAnchorTokens: number;
  findAncestors?: (momentId: string) => Promise<Moment[]>;
  logger?: any;
}): Promise<{
  chosenParentId: string | null;
  decisions: TimelineFitDecision[];
  stats: { candidateCount: number };
  selectorResult?: { selectedId: string | null; note?: string | null } | null;
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

  const llmSelector =
    input.useLlmSelector && input.ports.callLLM
      ? async (llmInput: {
          childText: string;
          childTimestamp: string;
          candidates: Array<{
            id: string;
            title: string | null;
            summary: string | null;
            relativeTime: string;
            ancestry: Array<{ title: string; summary: string }>;
          }>;
        }) => {
          const prompt =
            `You are the Timeline Fit Judge for "Machinen", an engine that reconstructs work history from event fragments (moments).\n\n` +
            `### THE JOB\n` +
            `We have a "Child" moment and a list of "Candidate" parent moments. Your task is to select the ONE candidate that represents the natural continuation of the timeline of moments.\n\n` +
            `### WHAT IS A "NATURAL CONTINUATION"?\n` +
            `A link is only valid if the Child is a natural next step or significant development of the Parent's activity.\n` +
            `- LINK: A situation -> Its evolution or consequence (e.g., Company hire -> Consequent win).\n` +
            `- LINK: A problem -> Its investigation or resolution.\n` +
            `- LINK: An initiative -> Its next major milestone.\n` +
            `- LINK: A question -> Its answer.\n` +
            `- LINK: Part 1 of a narrative -> Part 2 of that same narrative.\n\n` +
            `- NO LINK: Two unrelated events happening at the same time.\n` +
            `- NO LINK: Superficial semantic overlap (e.g. both mentions the same entities or terms but in entirely different contexts).\n\n` +
            `### CONTEXT\n` +
            `- Child Moment: ${llmInput.childText}\n` +
            `- Child Timestamp: ${llmInput.childTimestamp}\n\n` +
            `### CANDIDATES\n` +
            llmInput.candidates
              .map(
                (c, i) =>
                  `[${i + 1}] ID: ${c.id}\n` +
                  `TITLE: ${c.title ?? ""}\n` +
                  `SUMMARY: ${c.summary ?? ""}\n` +
                  `TIME: ${c.relativeTime} earlier\n\n` +
                  `#### ANCESTRY\n` +
                  (c.ancestry.length > 0
                    ? c.ancestry.map(a => `- ${a.title}: ${a.summary}`).join("\n")
                    : "- No history available") + "\n" +
                  `---------------------------------`
              )
              .join("\n\n") +
            `\n\n### OUTPUT\n` +
            `Return JSON:\n` +
            `{\n` +
            `  "selectedId": "...", // The ID of the best parent, or null if none fit\n` +
            `  "note": "..." // A brief 1-sentence explanation of why this is the natural progression.\n` +
            `}`;

          try {
            if (input.logger) {
              input.logger.info("timeline-fit:diagnostic:llm-selector-start", { childMomentId: input.childMomentId, candidateIds: llmInput.candidates.map(c => c.id) });
            }
            const raw = await input.ports.callLLM!(prompt);
            const parsed = parseLLMJson<{ selectedId: string | null; note?: string | null }>(raw);
            const selectedId = typeof parsed?.selectedId === "string" ? parsed.selectedId : null;
            const note = typeof parsed?.note === "string" ? parsed.note : null;
            if (input.logger) {
              input.logger.info("timeline-fit:diagnostic:llm-selector-result", { childMomentId: input.childMomentId, selectedId, note });
            }
            return { selectedId, note };
          } catch (err) {
            if (input.logger) {
              input.logger.warn("timeline-fit:diagnostic:llm-selector-fail", { childMomentId: input.childMomentId, error: err instanceof Error ? err.message : String(err) });
            }
            return { selectedId: null, note: null };
          }
        }
      : undefined;

  const proposal = await computeTimelineFitProposalDeep({
    childMomentId: input.childMomentId,
    childText: input.childText,
    childTimestamp: input.childTimestamp,
    candidates: input.candidates,
    extractAnchorTokens,
    maxAnchorTokens,
    maxSharedAnchorTokens,
    llmSelector,
    findAncestors: input.findAncestors,
    logger: input.logger,
  });

  return {
    chosenParentId: proposal.chosenParentId,
    decisions: proposal.decisions,
    stats: { candidateCount: proposal.candidateCount },
    selectorResult: proposal.selectorResult ?? null,
  };
}
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
    createdAt: string;
    isPredecessor?: boolean;
  }>;
}): Promise<{
  chosenParentId: string | null;
  chosenParentTitle: string | null;
  chosenParentSummary: string | null;
  childTitle: string | null;
  childSummary: string | null;
  outcome: string;
  decisions: any[];
  audit: any;
}> {
  const { context, childMoment, candidates } = input;
  
  const childText = `${childMoment.title || ""}\n${childMoment.summary || ""}`.trim();

  const proposal = await computeTimelineFitDecision({
    ports: { 
      callLLM: (prompt) => context.llm.call(prompt, "slow-reasoning", { 
        temperature: 0,
        logger: context.logger?.info,
      }) 
    },
    childMomentId: childMoment.id,
    childText,
    childTimestamp: childMoment.createdAt,
    candidates: candidates.map(c => ({
      ...c,
      documentId: (c as any).documentId || null,
    })),
    useLlmSelector: true,
    maxAnchorTokens: 24,
    maxSharedAnchorTokens: 12,
    findAncestors: (momentId) => findAncestors(momentId, {
      env: context.env,
      momentGraphNamespace: context.momentGraphNamespace || null
    }),
    logger: context.logger,
  });

  const chosenParent = proposal.chosenParentId 
    ? candidates.find(c => c.id === proposal.chosenParentId) 
    : null;

  const audit = {
    kind: "timeline_fit",
    ruleId: "narrative_continuation_selection",
    evidence: {
      chosenParentId: proposal.chosenParentId,
      decisions: proposal.decisions,
      stats: proposal.stats,
      selectorResult: proposal.selectorResult,
    },
  };

  return {
    chosenParentId: proposal.chosenParentId,
    chosenParentTitle: chosenParent?.title ?? null,
    chosenParentSummary: chosenParent?.summary ?? null,
    childTitle: childMoment.title ?? null,
    childSummary: childMoment.summary ?? null,
    outcome: proposal.chosenParentId ? "fit" : "no-fit",
    decisions: proposal.decisions,
    audit,
  };
}
