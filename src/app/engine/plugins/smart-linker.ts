import type {
  Plugin,
  MacroMomentDescription,
  IndexingHookContext,
  Document,
  MacroMomentParentProposal,
} from "../types";
import { getEmbedding } from "../utils/vector";
import { findDescendants, getMoment } from "../momentDb";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";

const DEFAULT_SMART_LINKER_THRESHOLD = 0.75;

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
      const queryText = `${macroMoment.title}: ${macroMoment.summary}`;

      console.log("[moment-linker] smart linker query", {
        documentId: document.id,
        macroMomentIndex,
        macroMomentTitle: macroMoment.title,
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
        if (matchNamespace !== momentGraphNamespace) {
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
