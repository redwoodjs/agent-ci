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
        })),
      });

      for (const match of results.matches) {
        const matchNamespace =
          (match.metadata as any)?.momentGraphNamespace ?? null;
        const normalizedMatchNamespace = matchNamespace ?? "default";
        if (normalizedMatchNamespace !== momentGraphNamespace) {
          continue;
        }
        const subject = await getMoment(match.id);
        if (!subject) {
          continue;
        }

        if (subject.documentId === document.id) {
          continue;
        }

        if (subject.parentId) {
          continue;
        }

        if (match.score < DEFAULT_SMART_LINKER_THRESHOLD) {
          continue;
        }

        const timeline = await findDescendants(subject.id);
        const last = timeline.length > 0 ? timeline[timeline.length - 1] : null;
        const parentMomentId = last?.id ?? subject.id;

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
      });

      return null;
    },
  },
};
