import type {
  Plugin,
  MacroMomentDescription,
  IndexingHookContext,
  Document,
  MacroMomentParentProposal,
} from "../types";
import { getEmbedding } from "../utils/vector";
import { getMoments } from "../momentDb";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";
import { callLLM } from "../utils/llm";

const DEFAULT_SMART_LINKER_THRESHOLD = 0.85;
const DEFAULT_SMART_LINKER_LLM_THRESHOLD = 0.6;
const DEFAULT_SMART_LINKER_MAX_QUERY_CHARS = 4000;

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
        return null;
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
        return null;
      }

      const cappedQuery = capText(
        rawQueryText,
        DEFAULT_SMART_LINKER_MAX_QUERY_CHARS
      );
      const queryText = cappedQuery.text ?? rawQueryText;

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

        if (subject.documentId === document.id) {
          decision.rejectReason = "same-document";
          candidateDecisions.push(decision);
          continue;
        }

        const score = match.score;

        if (score < DEFAULT_SMART_LINKER_LLM_THRESHOLD) {
          decision.rejectReason = "below-threshold";
          decision.threshold = DEFAULT_SMART_LINKER_LLM_THRESHOLD;
          candidateDecisions.push(decision);
          continue;
        }

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
        if (a.rank !== b.rank) {
          return a.rank - b.rank;
        }
        if (a.match.score !== b.match.score) {
          return b.match.score - a.match.score;
        }
        return a.match.id.localeCompare(b.match.id);
      });

      for (const entry of scoredCandidates) {
        const match = entry.match;
        const decision = entry.decision;
        const subject = entry.subject;
        const score = match.score;

        decision.rankApplied = entry.rank;

        // Logic:
        // >= threshold: Auto-accept
        // >= llm-threshold: LLM Check
        // < llm-threshold: Rejected above

        let shouldLink = false;

        if (score >= DEFAULT_SMART_LINKER_THRESHOLD) {
          shouldLink = true;
          decision.method = "auto-high-confidence";
        } else {
          // Band: 0.5 <= score < 0.75
          console.log("[moment-linker] invoking LLM reasoning for candidate", {
            documentId: document.id,
            macroMomentIndex,
            candidateId: subject.id,
            score,
          });

          decision.promptMode = "problem-workstream-same-thread";
          const parentStartMs = entry.parentStartMs;
          const parentTime =
            parentStartMs !== null ? new Date(parentStartMs).toISOString() : null;
          const childTime =
            childStartMs !== null ? new Date(childStartMs).toISOString() : null;

          const chronologicalEarlier =
            childStartMs !== null &&
            parentStartMs !== null &&
            childStartMs < parentStartMs
              ? {
                  title: macroMoment.title,
                  summary: macroMoment.summary || "No summary provided",
                  documentId: document.id,
                  time: childTime,
                }
              : {
                  title: subject.title,
                  summary: subject.summary,
                  documentId: subject.documentId,
                  time: parentTime,
                };

          const chronologicalLater =
            childStartMs !== null &&
            parentStartMs !== null &&
            childStartMs < parentStartMs
              ? {
                  title: subject.title,
                  summary: subject.summary,
                  documentId: subject.documentId,
                  time: parentTime,
                }
              : {
                  title: macroMoment.title,
                  summary: macroMoment.summary || "No summary provided",
                  documentId: document.id,
                  time: childTime,
                };

          decision.temporalInverted =
            childStartMs !== null &&
            parentStartMs !== null &&
            parentStartMs > childStartMs;

          const prompt = `You are a knowledge graph attachment classifier.
Your job is to decide whether two moments refer to the same problem/workstream.

## Moment A (chronologically earlier when known)
Time: ${chronologicalEarlier.time ?? "unknown"}
Title: ${chronologicalEarlier.title}
Summary: ${chronologicalEarlier.summary}
Document: ${chronologicalEarlier.documentId}

## Moment B (chronologically later when known)
Time: ${chronologicalLater.time ?? "unknown"}
Title: ${chronologicalLater.title}
Summary: ${chronologicalLater.summary}
Document: ${chronologicalLater.documentId}

## Task
Do Moment A and Moment B refer to the same problem/workstream?

Guidance:
- Do NOT answer YES just because they are in the same project/repo/library.
- Answer YES if the moments refer to the same problem being worked through, even when one is a different attempt, a partial fix, a follow-up, a test update, or a docs update.
- Answer NO if the relationship is only "same area" or "same repo" without a shared problem.

Examples:
- YES: "RSC navigation should prefetch pages by switching requests so caching works." and "Implemented prefetch link scanning and caching; added tests for link scanning and cache behavior."
- YES: "Prefetch links should exist for client navigation." and "Tried approach A, it failed; tried approach B, it worked; follow-up discussion about edge cases."
- YES: "A PR introduced change X." and "Updated docs and tests to reflect change X."
- YES: "Investigating why caching does not work due to request method or headers." and "Debugged request method, updated it, and confirmed caching behavior."
- NO: "Navigation caching / prefetch." and "Routing issue with unrelated endpoint or configuration."

Answer with exactly one word: YES or NO.`;

          try {
            const llmResult = await callLLM(prompt, "slow-reasoning", {
              temperature: 0,
              reasoning: { effort: "high" },
            });
            const answer = llmResult.trim().toUpperCase();
            decision.llmAnswer = answer;

            if (answer.includes("YES")) {
              shouldLink = true;
              decision.method = "llm-confirmed";
            } else {
              shouldLink = false;
              decision.rejectReason = "llm-rejected";
            }
          } catch (err) {
            console.error("[moment-linker] LLM check failed", err);
            decision.llmError = String(err);
            decision.rejectReason = "llm-failed";
            shouldLink = false;
          }
        }

        if (!shouldLink) {
          candidateDecisions.push(decision);
          continue;
        }

        const parentMomentId = subject.id;

        decision.accepted = true;
        decision.parentMomentId = parentMomentId;
        candidateDecisions.push(decision);

        console.log("[moment-linker] smart linker chose attachment", {
          documentId: document.id,
          macroMomentIndex,
          matchedSubjectId: subject.id,
          score: match.score,
          parentMomentId,
          subjectTitle: subject.title,
          subjectDocumentId: subject.documentId,
          subjectSourceRank: entry.rank,
          childStartMs,
          parentStartMs: entry.parentStartMs,
          parentEndMs: entry.parentEndMs,
          method: decision.method,
        });

        return {
          parentMomentId,
          matchedSubjectId: subject.id,
          score: match.score,
        };
      }

      console.log("[moment-linker] smart linker no attachment", {
        documentId: document.id,
        macroMomentIndex,
        threshold: DEFAULT_SMART_LINKER_LLM_THRESHOLD,
        candidates: candidateDecisions,
      });

      return null;
    },
  },
};
