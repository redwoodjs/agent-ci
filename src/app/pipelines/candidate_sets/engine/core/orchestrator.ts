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
    summary: string | null;
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
    filter: { momentGraphNamespace: (context as any).momentGraphNamespace || "default" }
  });

  const matches = (vectorResults?.matches ?? []).map((m: any) => ({
    id: m.id as string,
    score: m.score ?? null
  }));

  const matchIds = matches.map((m: any) => m.id as string);

  // 3. Load candidate rows details from Moment Graph
  const candidateMoments = await getMoments(matchIds, {
    env: context.env,
    momentGraphNamespace: (context as any).momentGraphNamespace || null,
  });
  
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
  const childStartMs = parseTimeMs(childMoment.createdAt);

  const built = buildCandidateSet({
    childMomentId: childMoment.id,
    childDocumentId: childMoment.documentId,
    childStartMs,
    matches,
    candidateRowsById: candidateRowsById as any,
    maxCandidates,
  });

  const finalCandidates = built.candidates.map((c: any) => ({
    id: c.id,
    score: c.score,
    documentId: c.documentId,
    title: c.title,
    summary: (candidateRowsById.get(c.id) as any)?.summary || null,
  }));

  return {
    candidates: finalCandidates,
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
