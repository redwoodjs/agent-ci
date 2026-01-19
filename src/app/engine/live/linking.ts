import type { MomentGraphContext } from "../databases/momentGraph";
import { getMoments } from "../databases/momentGraph";
import { getEmbedding } from "../utils/vector";
import { callLLM } from "../utils/llm";
import { resolveThreadHeadForDocumentAsOf } from "../core/linking/explicitRefThreadHead";
import { computeRootMacroMomentParentSelection } from "../core/linking/rootMacroMomentLinking";

export async function computeIndexDocumentParentForRootMacroMoment(input: {
  env: Cloudflare.Env;
  r2Key: string;
  documentId: string;
  momentGraphNamespace: string | null;
  momentGraphContext: MomentGraphContext;
  streamId: string;
  macroIndex: number;
  childMomentId: string;
  createdAt: string;
  sourceMetadata?: Record<string, any>;
  title: string | null;
  summary: string | null;
}): Promise<{
  parentId: string | null;
  auditLog: Record<string, any>;
}> {
  const ns = input.momentGraphNamespace ?? "default";
  return await computeRootMacroMomentParentSelection({
    ports: {
      deterministicLinking: {
        resolveThreadHeadForDocumentAsOf: async ({ documentId, asOfMs }) => {
          return await resolveThreadHeadForDocumentAsOf({
            documentId,
            asOfMs,
            context: input.momentGraphContext,
          });
        },
      },
      candidateSets: {
        getEmbedding: async (text) => await getEmbedding(text),
        vectorQuery: async (embedding, query) => {
          const queryOptions: Record<string, unknown> = {
            topK: query.topK,
            returnMetadata: true,
          };
          if (ns !== "default") {
            queryOptions.filter = { momentGraphNamespace: ns };
          }
          const results = await (input.env as any).MOMENT_INDEX.query(
            embedding,
            queryOptions as any
          );
          return {
            matches: (results?.matches ?? []).map((m: any) => ({
              id: typeof m?.id === "string" ? m.id : "",
              score: typeof m?.score === "number" ? m.score : null,
            })),
          };
        },
        loadCandidateRowsById: async (ids) => {
          const momentsMap =
            ids.length > 0
              ? await getMoments(ids, input.momentGraphContext)
              : new Map();
          const out = new Map<string, any>();
          for (const [id, m] of momentsMap.entries()) {
            out.set(id, {
              id,
              document_id: (m as any).documentId ?? null,
              created_at: (m as any).createdAt ?? null,
              source_metadata: (m as any).sourceMetadata ?? null,
              title: (m as any).title ?? null,
              summary: (m as any).summary ?? null,
            });
          }
          return out;
        },
      },
      timelineFit: {
        callLLM: async (prompt) =>
          await callLLM(prompt, "slow-reasoning", { temperature: 0 }),
      },
    },
    env: input.env,
    r2Key: input.r2Key,
    streamId: input.streamId,
    childMomentId: input.childMomentId,
    childDocumentId: input.documentId,
    childCreatedAt: input.createdAt,
    childSourceMetadata: input.sourceMetadata,
    childTitle: input.title,
    childSummary: input.summary,
    macroAnchors: null,
  });
}

