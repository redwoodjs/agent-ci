import { buildCandidateSet } from "../../lib/phaseCores/candidate_sets_core";

export type CandidateSetsPorts = {
  getEmbedding: (text: string) => Promise<number[]>;
  vectorQuery: (embedding: number[], input: { topK: number }) => Promise<{
    matches: Array<{ id: string; score: number | null }>;
  }>;
  loadCandidateRowsById: (ids: string[]) => Promise<
    Map<
      string,
      {
        id: string;
        document_id: string;
        created_at: string;
        source_metadata: any;
        title: string | null;
        summary: string | null;
      }
    >
  >;
};

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

function computeMomentStartMs(input: {
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const rangeStart = readTimeRangeStartMs(input.sourceMetadata);
  if (rangeStart !== null) {
    return rangeStart;
  }
  return parseTimeMs(input.createdAt);
}

export async function computeCandidateSet(input: {
  ports: CandidateSetsPorts;
  childMomentId: string;
  childDocumentId: string;
  childCreatedAt: string;
  childSourceMetadata?: Record<string, any>;
  childText: string;
  maxCandidates: number;
  vectorTopK?: number | null;
}): Promise<{
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string;
    title: string | null;
    createdAt: string;
  }>;
  stats: any;
  vectorTopK: number;
  debug: { queryPreview: string };
}> {
  const maxCandidates =
    Number.isFinite(input.maxCandidates) && input.maxCandidates > 0
      ? Math.floor(input.maxCandidates)
      : 10;
  const vectorTopK =
    Number.isFinite(input.vectorTopK) && (input.vectorTopK as number) > 0
      ? Math.floor(input.vectorTopK as number)
      : Math.max(10, maxCandidates * 3);

  const childStartMs =
    computeMomentStartMs({
      createdAt: input.childCreatedAt,
      sourceMetadata: input.childSourceMetadata,
    }) ?? null;

  const embedding = await input.ports.getEmbedding(input.childText);
  const results = await input.ports.vectorQuery(embedding, { topK: vectorTopK });

  const matchIds = (results?.matches ?? [])
    .map((m) => (typeof m?.id === "string" ? m.id : null))
    .filter(Boolean) as string[];
  const uniqueIds = Array.from(new Set(matchIds)).slice(0, vectorTopK);

  const candidateRowsById =
    uniqueIds.length > 0
      ? await input.ports.loadCandidateRowsById(uniqueIds)
      : new Map();

  const built = buildCandidateSet({
    childMomentId: input.childMomentId,
    childDocumentId: input.childDocumentId,
    childStartMs,
    matches: (results?.matches ?? []).map((m) => ({
      id: typeof m?.id === "string" ? m.id : "",
      score: typeof m?.score === "number" ? m.score : null,
    })),
    candidateRowsById: candidateRowsById as any,
    maxCandidates,
  });

  return {
    candidates: built.candidates,
    stats: {
      ...built.stats,
      vectorTopK,
    },
    vectorTopK,
    debug: { queryPreview: input.childText.slice(0, 200) },
  };
}

