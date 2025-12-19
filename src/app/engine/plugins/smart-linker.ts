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

const DEFAULT_SMART_LINKER_THRESHOLD = 0.75;
const DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD = 0.8;
const DEFAULT_SMART_LINKER_MAX_QUERY_CHARS = 4000;
const DEFAULT_SMART_LINKER_MAX_LLM_VETO_CANDIDATES = 3;

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

      if (eligibleCandidates.length === 0) {
        console.log("[moment-linker] smart linker no attachment", {
          documentId: document.id,
          macroMomentIndex,
          threshold: DEFAULT_SMART_LINKER_THRESHOLD,
          candidates: candidateDecisions,
        });
        return null;
      }

      const childTime =
        childStartMs !== null ? new Date(childStartMs).toISOString() : null;

      const candidatesForVeto = eligibleCandidates.slice(
        0,
        DEFAULT_SMART_LINKER_MAX_LLM_VETO_CANDIDATES
      );

      console.log("[moment-linker] smart linker invoking LLM veto", {
        documentId: document.id,
        macroMomentIndex,
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        autoAttachThreshold: DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD,
        candidateIds: candidatesForVeto.map((c) => c.subject.id),
      });

      for (const entry of candidatesForVeto) {
        const subject = entry.subject;
        const score = entry.match.score;
        const parentMomentId = subject.id;

        if (score >= DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD) {
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
            method: "auto-high-confidence",
          });

          return {
            parentMomentId,
            matchedSubjectId: subject.id,
            score,
          };
        }

        const parentStartMs = entry.parentStartMs;
        const parentTime =
          parentStartMs !== null ? new Date(parentStartMs).toISOString() : null;
        const temporalInverted =
          childStartMs !== null &&
          parentStartMs !== null &&
          parentStartMs > childStartMs;

        const vetoPrompt = `You are a knowledge graph attachment veto checker.
Your job is to decide whether an attachment is clearly wrong.

Return YES if the attachment is plausible.
Return NO if the attachment is clearly wrong / unrelated.
Return only YES or NO.

## Child moment
Time: ${childTime ?? "unknown"}
Title: ${macroMoment.title}
Summary: ${macroMoment.summary || "No summary provided"}
Document: ${document.id}

## Candidate parent moment
Time: ${parentTime ?? "unknown"}
Title: ${previewText(subject.title, 200) ?? subject.title}
Summary: ${previewText(subject.summary, 900) ?? subject.summary}
Document: ${subject.documentId}
VectorScore: ${score}
TemporalInverted: ${temporalInverted ? "true" : "false"}

Guidance:
- Say NO when it is clearly unrelated.
- Say YES when it could be the same specific problem, or when it is a related step in the same work.
- Do not say NO only because the two moments are not identical in wording.

Examples (NO):
- One is about SSR bridge architecture and the other is about deployment status noise.
- One is about an unrelated endpoint or configuration issue.

Examples (YES):
- One is about rwsdk client navigation mechanics and the other is about improving that same navigation system (prefetching/caching, switching navigation requests to GET).
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

        console.log("[moment-linker] smart linker LLM veto decision", {
          documentId: document.id,
          macroMomentIndex,
          candidateId: subject.id,
          score,
          vetoAnswer,
          allowed,
          method: "llm-veto",
        });

        if (!allowed) {
          continue;
        }

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
          method: "llm-veto",
        });

        return {
          parentMomentId,
          matchedSubjectId: subject.id,
          score,
        };
      }

      console.log("[moment-linker] smart linker no attachment", {
        documentId: document.id,
        macroMomentIndex,
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        autoAttachThreshold: DEFAULT_SMART_LINKER_AUTO_ATTACH_THRESHOLD,
        candidates: candidateDecisions,
      });

      return null;
    },
  },
};
