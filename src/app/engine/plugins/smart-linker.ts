import type {
  Plugin,
  MacroMomentDescription,
  IndexingHookContext,
  Document,
  MacroMomentParentProposal,
} from "../types";
import { getEmbedding } from "../utils/vector";
import {
  findDescendants,
  getMicroMomentsForDocument,
  getMoment,
} from "../momentDb";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";

const DEFAULT_SMART_LINKER_THRESHOLD = 0.75;
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
      const built = buildCappedMicroMomentQueryText(
        microTexts,
        DEFAULT_SMART_LINKER_MAX_QUERY_CHARS
      );
      const queryText = built.text;

      console.log("[moment-linker] smart linker query", {
        documentId: document.id,
        macroMomentIndex,
        macroMomentTitle: macroMoment.title,
        querySource: "micro-concat",
        microMomentsUsed: built.usedCount,
        microMomentsTotal: microMoments.length,
        queryPreview: queryText.slice(0, 200),
      });

      const embedding = await getEmbedding(queryText);
      const results = await context.env.SUBJECT_INDEX.query(embedding, {
        topK: 5,
        returnMetadata: true,
      });

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

        if (subject.parentId) {
          decision.rejectReason = "non-root-subject";
          candidateDecisions.push(decision);
          continue;
        }

        if (match.score < DEFAULT_SMART_LINKER_THRESHOLD) {
          decision.rejectReason = "below-threshold";
          decision.threshold = DEFAULT_SMART_LINKER_THRESHOLD;
          candidateDecisions.push(decision);
          continue;
        }

        const timeline = await findDescendants(subject.id);
        const last = timeline.length > 0 ? timeline[timeline.length - 1] : null;
        const parentMomentId = last?.id ?? subject.id;

        decision.accepted = true;
        decision.parentMomentId = parentMomentId;
        decision.subjectTimelineLength = timeline.length;
        candidateDecisions.push(decision);

        console.log("[moment-linker] smart linker chose attachment", {
          documentId: document.id,
          macroMomentIndex,
          matchedSubjectId: subject.id,
          score: match.score,
          parentMomentId,
          subjectTitle: subject.title,
          subjectDocumentId: subject.documentId,
          subjectTimelineLength: timeline.length,
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
