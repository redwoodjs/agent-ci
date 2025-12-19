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
const DEFAULT_SMART_LINKER_MAX_QUERY_CHARS = 4000;
const DEFAULT_SMART_LINKER_LLM_SCORE_THRESHOLD = 0.75;
const DEFAULT_SMART_LINKER_MAX_LLM_CANDIDATES = 5;

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

      const topCandidates = eligibleCandidates.slice(
        0,
        DEFAULT_SMART_LINKER_MAX_LLM_CANDIDATES
      );

      const childTime =
        childStartMs !== null ? new Date(childStartMs).toISOString() : null;

      const promptCandidates = topCandidates.map((entry) => {
        const subject = entry.subject;
        const parentStartMs = entry.parentStartMs;
        const parentTime =
          parentStartMs !== null ? new Date(parentStartMs).toISOString() : null;
        const temporalInverted =
          childStartMs !== null &&
          parentStartMs !== null &&
          parentStartMs > childStartMs;
        return {
          id: subject.id,
          documentId: subject.documentId,
          title: previewText(subject.title, 200) ?? subject.title,
          summary: previewText(subject.summary, 900) ?? subject.summary,
          time: parentTime,
          temporalInverted,
          vectorScore: entry.match.score,
        };
      });

      console.log("[moment-linker] smart linker invoking LLM for shortlist", {
        documentId: document.id,
        macroMomentIndex,
        shortlistCount: promptCandidates.length,
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        candidateIds: promptCandidates.map((c) => c.id),
      });

      const prompt = `You are a knowledge graph attachment classifier.
Your job is to decide whether a child moment refers to the same specific problem as one of the candidate parent moments.

## Child moment
Time: ${childTime ?? "unknown"}
Title: ${macroMoment.title}
Summary: ${macroMoment.summary || "No summary provided"}
Document: ${document.id}

## Candidate parent moments
${JSON.stringify(promptCandidates, null, 2)}

## Task
Pick at most one candidate parent moment.
Return JSON only, in this exact shape:
{"selectedId": "<id or null>", "score": <number from 0 to 1>}

Guidance:
- Decide based on the same specific problem, not the same area.
- If the relationship is only shared terms or shared repo/project, return selectedId=null with a low score.
- The parent link is not strict time ordering. The time fields are just metadata.
`;

      let chosenId: string | null = null;
      let llmScore: number | null = null;
      try {
        const llmResult = await callLLM(prompt, "slow-reasoning", {
          temperature: 0,
          reasoning: { effort: "high" },
        });
        const trimmed = llmResult.trim();
        const jsonStart = trimmed.indexOf("{");
        const jsonEnd = trimmed.lastIndexOf("}");
        const jsonText =
          jsonStart >= 0 && jsonEnd > jsonStart
            ? trimmed.slice(jsonStart, jsonEnd + 1)
            : null;
        const parsed = jsonText ? JSON.parse(jsonText) : null;

        const selectedIdRaw =
          parsed && typeof parsed.selectedId === "string"
            ? parsed.selectedId.trim()
            : parsed?.selectedId === null
            ? null
            : null;
        const scoreRaw =
          parsed && typeof parsed.score === "number" ? parsed.score : null;

        llmScore =
          typeof scoreRaw === "number" && Number.isFinite(scoreRaw)
            ? scoreRaw
            : null;

        if (selectedIdRaw && selectedIdRaw.toLowerCase() !== "null") {
          chosenId = selectedIdRaw;
        }
      } catch (err) {
        console.error("[moment-linker] LLM shortlist check failed", err);
      }

      const allowedIds = new Set(promptCandidates.map((c) => c.id));
      const selectedAllowed = chosenId !== null && allowedIds.has(chosenId);
      const shouldLink =
        selectedAllowed &&
        llmScore !== null &&
        llmScore >= DEFAULT_SMART_LINKER_LLM_SCORE_THRESHOLD;

      console.log("[moment-linker] smart linker LLM shortlist decision", {
        documentId: document.id,
        macroMomentIndex,
        selectedId: chosenId,
        selectedAllowed,
        llmScore,
        llmScoreThreshold: DEFAULT_SMART_LINKER_LLM_SCORE_THRESHOLD,
        method: "llm-shortlist",
      });

      if (!shouldLink || chosenId === null) {
        console.log("[moment-linker] smart linker no attachment", {
          documentId: document.id,
          macroMomentIndex,
          threshold: DEFAULT_SMART_LINKER_THRESHOLD,
          candidates: candidateDecisions,
        });
        return null;
      }

      const chosen =
        topCandidates.find((c) => c.subject.id === chosenId) ?? null;
      if (!chosen) {
        console.log("[moment-linker] smart linker no attachment", {
          documentId: document.id,
          macroMomentIndex,
          threshold: DEFAULT_SMART_LINKER_THRESHOLD,
          candidates: candidateDecisions,
        });
        return null;
      }

      const parentMomentId = chosen.subject.id;

      console.log("[moment-linker] smart linker chose attachment", {
        documentId: document.id,
        macroMomentIndex,
        matchedSubjectId: chosen.subject.id,
        score: chosen.match.score,
        parentMomentId,
        subjectTitle: chosen.subject.title,
        subjectDocumentId: chosen.subject.documentId,
        subjectSourceRank: chosen.rank,
        childStartMs,
        parentStartMs: chosen.parentStartMs,
        parentEndMs: chosen.parentEndMs,
        method: "llm-shortlist",
        llmScore,
      });

      return {
        parentMomentId,
        matchedSubjectId: chosen.subject.id,
        score: chosen.match.score,
      };
    },
  },
};
