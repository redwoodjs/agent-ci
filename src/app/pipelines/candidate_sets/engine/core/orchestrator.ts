import { buildCandidateSet } from "../../../../engine/lib/phaseCores/candidateSetsCore";
import { getEmbedding } from "../../../../engine/utils/vector";
import { PipelineContext } from "../../../../engine/runtime/types";
import { Moment } from "../../../../engine/types";
import { getMoments } from "../../../../engine/databases/momentGraph";

export async function runCandidateSetComputation(input: {
  context: PipelineContext;
  childMoment: Moment;
  maxCandidates: number;
  vectorTopK?: number;
}): Promise<{
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string;
    title: string | null;
    createdAt: string;
  }>;
  stats: any;
}> {
  const { context, childMoment } = input;
  const queryText = (childMoment.summary?.trim() || childMoment.title?.trim() || "");
  
  if (!queryText) {
    return { 
      candidates: [], 
      stats: { reason: "empty-query" } 
    };
  }

  const maxCandidates = input.maxCandidates || 10;
  const vectorTopK = input.vectorTopK || Math.max(10, maxCandidates * 3);

  // 1. Get embedding
  const embedding = await getEmbedding(queryText);

  // 2. Vector Query
  const vectorResults = await (context.env as any).MOMENT_INDEX.query(embedding, {
    topK: vectorTopK,
    returnMetadata: true,
    filter: { momentGraphNamespace: context.momentGraphNamespace || "default" }
  });

  const matches = (vectorResults?.matches ?? []).map((m: any) => ({
    id: m.id as string,
    score: m.score ?? null
  }));

  const matchIds = matches.map(m => m.id as string);
  const uniqueIds = Array.from(new Set(matchIds)).slice(0, vectorTopK);

  // 3. Load candidate rows details from Moment Graph
  const candidateMoments = uniqueIds.length > 0 
    ? await getMoments(uniqueIds, {
        env: context.env,
        momentGraphNamespace: context.momentGraphNamespace || null
      })
    : new Map<string, any>();
  
  const candidateRowsById = new Map<string, any>(
    Array.from(candidateMoments.entries()).map(([id, r]: [string, any]) => [id, {
      id: r.id,
      document_id: r.documentId,
      created_at: r.createdAt,
      source_metadata: r.sourceMetadata,
      title: r.title,
      summary: r.summary
    }])
  );

  // 4. Build Candidate Set using legacy logic
  const childStartMs = parseTimeMs(childMoment.createdAt); // Simplified for now, or use core logic if needed

  const built = buildCandidateSet({
    childMomentId: childMoment.id,
    childDocumentId: childMoment.documentId,
    childStartMs,
    matches,
    candidateRowsById: candidateRowsById as any,
    maxCandidates,
  });

  return {
    candidates: built.candidates,
    stats: {
      ...built.stats,
      vectorTopK,
    }
  };
}

function parseTimeMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
