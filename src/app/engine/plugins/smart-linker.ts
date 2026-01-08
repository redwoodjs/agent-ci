import type {
  Plugin,
  MacroMomentDescription,
  IndexingHookContext,
  Document,
  MacroMomentParentProposal,
} from "../types";
import { getEmbedding } from "../utils/vector";
import { getChainContextForMoment, getMoments } from "../momentDb";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";
import { callLLM } from "../utils/llm";

const DEFAULT_SMART_LINKER_THRESHOLD = 0.75;
const DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD = 0.8;
const DEFAULT_SMART_LINKER_MAX_QUERY_CHARS = 4000;
const DEFAULT_SMART_LINKER_MAX_LLM_VETO_CANDIDATES = 3;
const DEFAULT_SMART_LINKER_TIMELINE_MAX_TAIL = 12;
const DEFAULT_SMART_LINKER_TIMELINE_HIGH_IMPORTANCE_CUTOFF = 0.8;
const DEFAULT_SMART_LINKER_TIMELINE_MAX_HIGH_IMPORTANCE = 6;
const DEFAULT_SMART_LINKER_TIMELINE_MAX_DESCENDANT_SCAN_NODES = 400;
const DEFAULT_SMART_LINKER_TIMELINE_MAX_CONTEXT_CHARS = 3200;

function previewText(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function capText(
  value: unknown,
  maxChars: number
): { text: string | null; truncated: boolean } {
  if (typeof value !== "string") {
    return { text: null, truncated: false };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { text: null, truncated: false };
  }
  if (trimmed.length > maxChars) {
    return { text: trimmed.slice(0, maxChars), truncated: true };
  }
  return { text: trimmed, truncated: false };
}

function parseEnvInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function parseEnvFloat(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function buildTimelineContextText(input: {
  root: { id: string; title: string; summary: string; createdAt: string } | null;
  tail: Array<{ id: string; title: string; summary: string; createdAt: string }>;
  highImportance: Array<{
    id: string;
    title: string;
    summary: string;
    createdAt: string;
    importance?: number;
  }>;
}): string {
  const lines: string[] = [];
  if (input.root) {
    lines.push("Root:");
    lines.push(`- Time: ${input.root.createdAt}`);
    lines.push(`- Title: ${input.root.title}`);
    lines.push(`- Summary: ${input.root.summary}`);
    lines.push("");
  }

  if (input.tail.length > 0) {
    lines.push("Recent chain tail:");
    for (const item of input.tail) {
      lines.push(`- Time: ${item.createdAt}`);
      lines.push(`  Title: ${item.title}`);
      lines.push(`  Summary: ${item.summary}`);
    }
    lines.push("");
  }

  if (input.highImportance.length > 0) {
    lines.push("High-importance sample:");
    for (const item of input.highImportance) {
      lines.push(
        `- Importance: ${
          typeof item.importance === "number" ? item.importance : "unknown"
        }`
      );
      lines.push(`  Time: ${item.createdAt}`);
      lines.push(`  Title: ${item.title}`);
      lines.push(`  Summary: ${item.summary}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export const smartLinkerPlugin: Plugin = {
  name: "smart-linker",

  subjects: {
    async proposeMacroMomentParent(
      document: Document,
      macroMoment: MacroMomentDescription,
      macroMomentIndex: number,
      context: IndexingHookContext
    ): Promise<MacroMomentParentProposal | null> {
      if (!macroMoment) {
        return null;
      }

      if (
        !context.env.SUBJECT_INDEX ||
        typeof (context.env.SUBJECT_INDEX as any).query !== "function"
      ) {
        console.log("[moment-linker] smart linker skipped (no SUBJECT_INDEX)", {
          documentId: document.id,
          macroMomentIndex,
        });
        return {
          parentMomentId: null,
          matchedSubjectId: null,
          score: null,
          auditLog: {
            plugin: "smart-linker",
            skipped: true,
            skippedReason: "no-subject-index",
            documentId: document.id,
            macroMomentIndex,
          },
        };
      }

      const momentGraphNamespace =
        context.momentGraphNamespace ??
        getMomentGraphNamespaceFromEnv(context.env) ??
        "default";
      const momentGraphContext = {
        env: context.env,
        momentGraphNamespace:
          context.momentGraphNamespace ??
          getMomentGraphNamespaceFromEnv(context.env) ??
          null,
      };

      const rawQueryText =
        typeof macroMoment.summary === "string" && macroMoment.summary.trim()
          ? macroMoment.summary.trim()
          : typeof macroMoment.title === "string" && macroMoment.title.trim()
          ? macroMoment.title.trim()
          : null;

      if (!rawQueryText) {
        console.log("[moment-linker] smart linker skipped (no query text)", {
          documentId: document.id,
          macroMomentIndex,
          macroMomentTitle: macroMoment.title,
        });
        return {
          parentMomentId: null,
          matchedSubjectId: null,
          score: null,
          auditLog: {
            plugin: "smart-linker",
            skipped: true,
            skippedReason: "no-query-text",
            documentId: document.id,
            macroMomentIndex,
            macroMomentTitle: macroMoment.title ?? null,
          },
        };
      }

      const cappedQuery = capText(
        rawQueryText,
        DEFAULT_SMART_LINKER_MAX_QUERY_CHARS
      );
      const queryText = cappedQuery.text ?? rawQueryText;

      const auditLog: Record<string, any> = {
        plugin: "smart-linker",
        documentId: document.id,
        macroMomentIndex,
        momentGraphNamespace,
        thresholds: {
          threshold: DEFAULT_SMART_LINKER_THRESHOLD,
          autoAttachThreshold: DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD,
          maxQueryChars: DEFAULT_SMART_LINKER_MAX_QUERY_CHARS,
          maxLlmVetoCandidates: DEFAULT_SMART_LINKER_MAX_LLM_VETO_CANDIDATES,
        },
        query: {
          source: "macro-summary",
          truncated: cappedQuery.truncated,
          preview: queryText.slice(0, 200),
        },
        candidates: [],
        outcome: null,
      };

      console.log("[moment-linker] smart linker query", {
        documentId: document.id,
        macroMomentIndex,
        macroMomentTitle: macroMoment.title,
        querySource: "macro-summary",
        queryTextTruncated: cappedQuery.truncated,
        queryPreview: queryText.slice(0, 200),
      });

      const embedding = await getEmbedding(queryText);
      const queryOptions: Record<string, unknown> = {
        topK: 20,
        returnMetadata: true,
      };
      if (momentGraphNamespace !== "default") {
        queryOptions.filter = { momentGraphNamespace };
      }
      let results = await context.env.SUBJECT_INDEX.query(
        embedding,
        queryOptions as any
      );

      if (!results.matches || results.matches.length === 0) {
        if (
          context.env.MOMENT_INDEX &&
          typeof (context.env.MOMENT_INDEX as any).query === "function"
        ) {
          console.log("[moment-linker] smart linker fallback to MOMENT_INDEX", {
            documentId: document.id,
            macroMomentIndex,
            momentGraphNamespace,
          });
          results = await context.env.MOMENT_INDEX.query(
            embedding,
            queryOptions as any
          );
        }
      }

      console.log("[moment-linker] smart linker candidates", {
        documentId: document.id,
        macroMomentIndex,
        matches: results.matches.map((m) => ({
          id: m.id,
          score: m.score,
          matchNamespace: (m.metadata as any)?.momentGraphNamespace ?? null,
          matchDocumentId: (m.metadata as any)?.documentId ?? null,
          matchIsSubject: (m.metadata as any)?.isSubject ?? null,
          matchType: (m.metadata as any)?.type ?? null,
        })),
      });

      const candidateDecisions: Array<Record<string, unknown>> = [];

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

      function readTimeRangeEndMs(value: unknown): number | null {
        const range = (value as any)?.timeRange;
        const end = range?.end;
        return parseTimeMs(end);
      }

      const childStartMs =
        readTimeRangeStartMs(macroMoment.sourceMetadata) ??
        parseTimeMs(macroMoment.createdAt);

      function sourceRankForDocumentId(documentId: string): number {
        const lower = documentId.toLowerCase();
        if (lower.startsWith("github/")) {
          return 0;
        }
        if (lower.startsWith("discord/")) {
          return 1;
        }
        if (lower.startsWith("cursor/")) {
          return 2;
        }
        return 3;
      }

      const matchIds = results.matches
        .map((m) => m?.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
      const momentsMap =
        matchIds.length > 0
          ? await getMoments(matchIds, momentGraphContext)
          : null;

      const scoredCandidates: Array<{
        match: (typeof results.matches)[number];
        decision: Record<string, unknown>;
        subject: any;
        rank: number;
        parentStartMs: number | null;
        parentEndMs: number | null;
      }> = [];

      for (const match of results.matches) {
        const matchMetadata = (match.metadata as any) ?? null;
        const matchNamespace = matchMetadata?.momentGraphNamespace ?? null;
        const normalizedMatchNamespace = matchNamespace ?? "default";

        const decision: Record<string, unknown> = {
          id: match.id,
          score: match.score,
          expectedNamespace: momentGraphNamespace,
          matchNamespace: normalizedMatchNamespace,
          matchDocumentId: matchMetadata?.documentId ?? null,
          matchIsSubject: matchMetadata?.isSubject ?? null,
          matchType: matchMetadata?.type ?? null,
          matchTitlePreview: previewText(matchMetadata?.title, 120),
          matchSummaryPreview: previewText(matchMetadata?.summary, 160),
        };

        if (normalizedMatchNamespace !== momentGraphNamespace) {
          decision.rejectReason = "namespace-mismatch";
          candidateDecisions.push(decision);
          continue;
        }

        const subject = momentsMap ? momentsMap.get(match.id) : null;
        if (!subject) {
          decision.rejectReason = "missing-moment-row";
          candidateDecisions.push(decision);
          continue;
        }

        decision.subjectDocumentId = subject.documentId;
        decision.subjectParentId = subject.parentId ?? null;
        decision.subjectSourceRank = sourceRankForDocumentId(
          subject.documentId
        );

        if (
          subject.title?.trim() === "Summarized micro-moments" &&
          subject.summary?.trim() === "Synthesized macro-moments could not be parsed."
        ) {
          decision.rejectReason = "macro-synthesis-parse-failure-placeholder";
          candidateDecisions.push(decision);
          continue;
        }

        if (subject.documentId === document.id) {
          decision.rejectReason = "same-document";
          candidateDecisions.push(decision);
          continue;
        }

        const score = match.score;

        const parentStartMs =
          readTimeRangeStartMs(subject.sourceMetadata) ??
          parseTimeMs(subject.createdAt);
        const parentEndMs =
          readTimeRangeEndMs(subject.sourceMetadata) ??
          parseTimeMs(subject.createdAt);
        decision.childStartMs = childStartMs;
        decision.parentStartMs = parentStartMs;
        decision.parentEndMs = parentEndMs;
        const temporalInverted =
          childStartMs !== null &&
          parentStartMs !== null &&
          parentStartMs > childStartMs;
        if (temporalInverted) {
          decision.temporalInverted = true;
        }
        if (
          childStartMs !== null &&
          parentEndMs !== null &&
          parentEndMs > childStartMs
        ) {
          decision.temporalNote = "parent-end-after-child-start";
        }

        scoredCandidates.push({
          match,
          decision,
          subject,
          rank: sourceRankForDocumentId(subject.documentId),
          parentStartMs,
          parentEndMs,
        });
      }

      scoredCandidates.sort((a, b) => {
        if (a.match.score !== b.match.score) {
          return b.match.score - a.match.score;
        }
        return a.match.id.localeCompare(b.match.id);
      });

      const eligibleCandidates = scoredCandidates.filter(
        (entry) => entry.match.score >= DEFAULT_SMART_LINKER_THRESHOLD
      );

      for (const entry of scoredCandidates) {
        const decision = entry.decision;
        decision.rankApplied = entry.rank;
        if (entry.match.score < DEFAULT_SMART_LINKER_THRESHOLD) {
          decision.rejectReason = "below-threshold";
          decision.threshold = DEFAULT_SMART_LINKER_THRESHOLD;
        } else {
          decision.shortlisted = true;
        }
        candidateDecisions.push(decision);
      }

      auditLog.candidates = candidateDecisions;

      if (eligibleCandidates.length === 0) {
        console.log("[moment-linker] smart linker no attachment", {
          documentId: document.id,
          macroMomentIndex,
          threshold: DEFAULT_SMART_LINKER_THRESHOLD,
          candidates: candidateDecisions,
        });
        auditLog.outcome = {
          attached: false,
          reason: "no-eligible-candidates",
        };
        return {
          parentMomentId: null,
          matchedSubjectId: null,
          score: null,
          auditLog,
        };
      }

      const childTime =
        childStartMs !== null ? new Date(childStartMs).toISOString() : null;

      const candidatesForVeto = eligibleCandidates.slice(
        0,
        DEFAULT_SMART_LINKER_MAX_LLM_VETO_CANDIDATES
      );

      const timelineMaxTail = parseEnvInt(
        (context.env as any).SMART_LINKER_TIMELINE_MAX_TAIL,
        DEFAULT_SMART_LINKER_TIMELINE_MAX_TAIL
      );
      const timelineHighImportanceCutoff = parseEnvFloat(
        (context.env as any).SMART_LINKER_TIMELINE_HIGH_IMPORTANCE_CUTOFF,
        DEFAULT_SMART_LINKER_TIMELINE_HIGH_IMPORTANCE_CUTOFF
      );
      const timelineMaxHighImportance = parseEnvInt(
        (context.env as any).SMART_LINKER_TIMELINE_MAX_HIGH_IMPORTANCE,
        DEFAULT_SMART_LINKER_TIMELINE_MAX_HIGH_IMPORTANCE
      );
      const timelineMaxDescendantScanNodes = parseEnvInt(
        (context.env as any).SMART_LINKER_TIMELINE_MAX_DESCENDANT_SCAN_NODES,
        DEFAULT_SMART_LINKER_TIMELINE_MAX_DESCENDANT_SCAN_NODES
      );
      const timelineMaxContextChars = parseEnvInt(
        (context.env as any).SMART_LINKER_TIMELINE_MAX_CONTEXT_CHARS,
        DEFAULT_SMART_LINKER_TIMELINE_MAX_CONTEXT_CHARS
      );

      console.log("[moment-linker] smart linker invoking timeline fit check", {
        documentId: document.id,
        macroMomentIndex,
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        autoAttachThreshold: DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD,
        candidateIds: candidatesForVeto.map((c) => c.subject.id),
        timelineMaxTail,
        timelineHighImportanceCutoff,
        timelineMaxHighImportance,
        timelineMaxDescendantScanNodes,
        timelineMaxContextChars,
      });

      for (const entry of candidatesForVeto) {
        const subject = entry.subject;
        const score = entry.match.score;
        const parentMomentId = subject.id;

        const parentStartMs = entry.parentStartMs;
        const parentTime =
          parentStartMs !== null ? new Date(parentStartMs).toISOString() : null;
        const temporalInverted =
          childStartMs !== null &&
          parentStartMs !== null &&
          parentStartMs > childStartMs;

        const chainContext = await getChainContextForMoment(parentMomentId, {
          env: context.env,
          momentGraphNamespace: momentGraphContext.momentGraphNamespace,
        }, {
          maxTail: timelineMaxTail,
          highImportanceCutoff: timelineHighImportanceCutoff,
          maxHighImportance: timelineMaxHighImportance,
          maxDescendantScanNodes: timelineMaxDescendantScanNodes,
        });

        entry.decision.timelineContext = chainContext
          ? {
              rootId: chainContext.rootId,
              maxTail: chainContext.maxTail,
              highImportanceCutoff: chainContext.highImportanceCutoff,
              maxHighImportance: chainContext.maxHighImportance,
              maxDescendantScanNodes: chainContext.maxDescendantScanNodes,
              truncated: chainContext.truncated,
              tailCount: chainContext.tail.length,
              highImportanceCount: chainContext.highImportanceSample.length,
            }
          : null;

        const timelineText =
          chainContext && chainContext.root
            ? buildTimelineContextText({
                root: {
                  id: chainContext.root.id,
                  title: previewText(chainContext.root.title, 200) ?? chainContext.root.title,
                  summary:
                    previewText(chainContext.root.summary, 700) ??
                    chainContext.root.summary,
                  createdAt: chainContext.root.createdAt,
                },
                tail: chainContext.tail.map((m) => ({
                  id: m.id,
                  title: previewText(m.title, 200) ?? m.title,
                  summary: previewText(m.summary, 500) ?? m.summary,
                  createdAt: m.createdAt,
                })),
                highImportance: chainContext.highImportanceSample.map((m) => ({
                  id: m.id,
                  title: previewText(m.title, 200) ?? m.title,
                  summary: previewText(m.summary, 500) ?? m.summary,
                  createdAt: m.createdAt,
                  importance: m.importance,
                })),
              })
            : "";

        const cappedTimeline = capText(timelineText, timelineMaxContextChars);
        entry.decision.timelineContextTruncated = cappedTimeline.truncated;

        const vetoPrompt = `You are a knowledge graph timeline fit checker.
Your job is to decide whether a proposed moment belongs in a candidate timeline.

Return YES if the proposed moment fits into the candidate timeline.
Return NO if it does not fit into the timeline.
Return only YES or NO.

## Proposed moment
Time: ${childTime ?? "unknown"}
Title: ${macroMoment.title}
Summary: ${macroMoment.summary || "No summary provided"}
Document: ${document.id}

## Candidate attachment point
CandidateParentTime: ${parentTime ?? "unknown"}
CandidateParentTitle: ${previewText(subject.title, 200) ?? subject.title}
CandidateParentSummary: ${previewText(subject.summary, 900) ?? subject.summary}
CandidateParentDocument: ${subject.documentId}
VectorScore: ${score}
TemporalInverted: ${temporalInverted ? "true" : "false"}

## Candidate timeline (bounded context)
${cappedTimeline.text || "(missing timeline context)"}

Guidance:
- Say YES when this is part of the same specific work item and the timeline context supports it.
- Say NO when it is only broadly about the same area but does not belong in this chain's work timeline.
- Prefer NO when the only support is generic topical similarity without shared anchors.
`;

        let vetoAnswer: string | null = null;
        try {
          const llmResult = await callLLM(vetoPrompt, "slow-reasoning", {
            temperature: 0,
            reasoning: { effort: "high" },
          });
          vetoAnswer = llmResult.trim().split(/\s+/)[0]?.toUpperCase() ?? null;
        } catch (err) {
          console.error("[moment-linker] LLM veto check failed", err);
        }

        const allowed =
          vetoAnswer === "YES" || vetoAnswer === "Y" || vetoAnswer === "TRUE";

        entry.decision.timelineFitAnswer = vetoAnswer;
        entry.decision.timelineFitAllowed = allowed;

        console.log("[moment-linker] smart linker timeline fit decision", {
          documentId: document.id,
          macroMomentIndex,
          candidateId: subject.id,
          score,
          timelineFitAnswer: vetoAnswer,
          allowed,
          method: "llm-timeline-fit",
        });

        if (!allowed) {
          entry.decision.rejectReason = "llm-timeline-fit";
          continue;
        }

        entry.decision.chosen = true;
        entry.decision.chosenMethod =
          score >= DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD
            ? "auto-high-confidence-timeline-fit"
            : "llm-timeline-fit";

        console.log("[moment-linker] smart linker chose attachment", {
          documentId: document.id,
          macroMomentIndex,
          matchedSubjectId: subject.id,
          score,
          parentMomentId,
          subjectTitle: subject.title,
          subjectDocumentId: subject.documentId,
          subjectSourceRank: entry.rank,
          childStartMs,
          parentStartMs: entry.parentStartMs,
          parentEndMs: entry.parentEndMs,
          method:
            score >= DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD
              ? "auto-high-confidence-timeline-fit"
              : "llm-timeline-fit",
        });

        auditLog.outcome = {
          attached: true,
          method:
            score >= DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD
              ? "auto-high-confidence-timeline-fit"
              : "llm-timeline-fit",
          parentMomentId,
          matchedSubjectId: subject.id,
          score,
        };
        return {
          parentMomentId,
          matchedSubjectId: subject.id,
          score,
          auditLog,
        };
      }

      console.log("[moment-linker] smart linker no attachment", {
        documentId: document.id,
        macroMomentIndex,
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        autoAttachThreshold: DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD,
        candidates: candidateDecisions,
      });

      auditLog.outcome = {
        attached: false,
        reason: "llm-timeline-fit-rejected-all",
      };
      return {
        parentMomentId: null,
        matchedSubjectId: null,
        score: null,
        auditLog,
      };
    },
  },
};
