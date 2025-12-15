import type {
  Plugin,
  MacroMomentDescription,
  IndexingHookContext,
  Document,
  MacroMomentParentProposal,
} from "../types";
import { getEmbedding } from "../utils/vector";
import { getMicroMomentsForDocument, getMoment } from "../momentDb";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";

const DEFAULT_SMART_LINKER_THRESHOLD = 0.75;
const DEFAULT_SMART_LINKER_MAX_QUERY_CHARS = 4000;
const DEFAULT_SMART_LINKER_MAX_LOG_MICRO_TEXT_CHARS = 2000;

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

function buildCappedMicroMomentQueryText(
  microMomentTexts: string[],
  maxChars: number
): { text: string; usedCount: number } {
  let out = "";
  let usedCount = 0;

  for (const rawText of microMomentTexts) {
    const text = rawText.trim();
    if (!text) {
      continue;
    }

    const separator = out.length > 0 ? "\n\n" : "";
    const remaining = maxChars - out.length - separator.length;
    if (remaining <= 0) {
      break;
    }

    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    out = `${out}${separator}${slice}`;
    usedCount += 1;

    if (out.length >= maxChars) {
      break;
    }
  }

  return { text: out, usedCount };
}

function buildCappedMicroMomentQueryTextWithIndices(
  microMomentTexts: string[],
  maxChars: number
): { text: string; usedIndices: number[] } {
  let out = "";
  const usedIndices: number[] = [];

  for (let i = 0; i < microMomentTexts.length; i++) {
    const rawText = microMomentTexts[i];
    const text = rawText.trim();
    if (!text) {
      continue;
    }

    const separator = out.length > 0 ? "\n\n" : "";
    const remaining = maxChars - out.length - separator.length;
    if (remaining <= 0) {
      break;
    }

    const slice = text.length > remaining ? text.slice(0, remaining) : text;
    out = `${out}${separator}${slice}`;
    usedIndices.push(i);

    if (out.length >= maxChars) {
      break;
    }
  }

  return { text: out, usedIndices };
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
        getMomentGraphNamespaceFromEnv(context.env) ?? "default";
      const microMoments = await getMicroMomentsForDocument(document.id);
      const microTexts = microMoments.map((m) => m.summary ?? m.content);
      const built = buildCappedMicroMomentQueryTextWithIndices(
        microTexts,
        DEFAULT_SMART_LINKER_MAX_QUERY_CHARS
      );
      const queryText = built.text;
      const usedMicroMoments = built.usedIndices.map((idx) => {
        const m = microMoments[idx] as any;
        const text = microTexts[idx] ?? "";
        const capped = capText(
          text,
          DEFAULT_SMART_LINKER_MAX_LOG_MICRO_TEXT_CHARS
        );
        return {
          path: m?.path ?? null,
          summaryPreview: previewText(text, 160),
          text: capped.text,
          textTruncated: capped.truncated,
        };
      });

      console.log("[moment-linker] smart linker query", {
        documentId: document.id,
        macroMomentIndex,
        macroMomentTitle: macroMoment.title,
        querySource: "micro-concat",
        microMomentsUsed: built.usedIndices.length,
        microMomentsTotal: microMoments.length,
        queryPreview: queryText.slice(0, 200),
        usedMicroMoments,
      });

      const embedding = await getEmbedding(queryText);
      const queryOptions: Record<string, unknown> = {
        topK: 5,
        returnMetadata: true,
      };
      if (momentGraphNamespace !== "default") {
        queryOptions.filter = { momentGraphNamespace };
      }
      const results = await context.env.SUBJECT_INDEX.query(
        embedding,
        queryOptions as any
      );

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

        const subject = await getMoment(match.id);
        if (!subject) {
          decision.rejectReason = "missing-moment-row";
          candidateDecisions.push(decision);
          continue;
        }

        decision.subjectDocumentId = subject.documentId;
        decision.subjectParentId = subject.parentId ?? null;

        if (subject.documentId === document.id) {
          decision.rejectReason = "same-document";
          candidateDecisions.push(decision);
          continue;
        }

        if (match.score < DEFAULT_SMART_LINKER_THRESHOLD) {
          decision.rejectReason = "below-threshold";
          decision.threshold = DEFAULT_SMART_LINKER_THRESHOLD;
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
        threshold: DEFAULT_SMART_LINKER_THRESHOLD,
        candidates: candidateDecisions,
      });

      return null;
    },
  },
};
