
import { getEmbedding } from "../../../../engine/utils/vector";
import { PipelineContext } from "../../../../engine/runtime/types";
import { Moment } from "../../../../engine/types";
import { getMoments, findMomentsByAnchors } from "../../../../engine/databases/momentGraph";


export type CandidateSetInput = {
  childMomentId: string;
  childDocumentId: string;
  childStartMs: number | null;
  matches: Array<{ id: string; score: number | null }>;
  candidateRowsById: Map<
    string,
    {
      id: string;
      document_id: string;
      created_at: string;
      source_metadata: any;
      title: string | null;
      summary: string | null;
    }
  >;
  maxCandidates: number;
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

export function buildCandidateSet(input: CandidateSetInput): {
  candidates: Array<{
    id: string;
    score: number | null;
    documentId: string;
    title: string | null;
    createdAt: string;
  }>;
  stats: {
    maxCandidates: number;
    matchesSeen: number;
    uniqueIdsSeen: number;
    filtered: {
      missingRow: number;
      self: number;
      sameDoc: number;
      timeInversion: number;
    };
  };
} {
  const filtered = {
    missingRow: 0,
    self: 0,
    sameDoc: 0,
    timeInversion: 0,
  };

  const candidates: Array<{
    id: string;
    score: number | null;
    documentId: string;
    title: string | null;
    createdAt: string;
  }> = [];

  const seen = new Set<string>();
  for (const match of input.matches ?? []) {
    const id = typeof match?.id === "string" ? match.id : "";
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);

    if (id === input.childMomentId) {
      filtered.self++;
      continue;
    }
    const row = input.candidateRowsById.get(id);
    if (!row) {
      filtered.missingRow++;
      continue;
    }
    // ALLOW same-document moments (for stream chaining in timeline_fit)

    const parentStartMs =
      computeMomentStartMs({
        createdAt: row.created_at,
        sourceMetadata: row.source_metadata ?? undefined,
      }) ?? null;
    const inverted =
      input.childStartMs !== null &&
      parentStartMs !== null &&
      parentStartMs > input.childStartMs;
    if (inverted) {
      filtered.timeInversion++;
      continue;
    }

    candidates.push({
      id,
      score: typeof match?.score === "number" ? match.score : null,
      documentId: row.document_id,
      title: row.title ?? null,
      createdAt: row.created_at,
    });

    if (candidates.length >= input.maxCandidates) {
      break;
    }
  }

  return {
    candidates,
    stats: {
      maxCandidates: input.maxCandidates,
      matchesSeen: Array.isArray(input.matches) ? input.matches.length : 0,
      uniqueIdsSeen: seen.size,
      filtered,
    },
  };
}

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
    createdAt: string;
    sourceMetadata?: any;
    isPredecessor?: boolean;
  }>;
  childTitle: string | null;
  childSummary: string | null;
  stats: any;
}> {
  const { context, childMoment } = input;
  const parts = [
    childMoment.summary,
    childMoment.title,
    ...(childMoment.anchors || [])
  ].filter(s => typeof s === "string" && s.trim().length > 0);
  
  const queryText = parts.join("\n").trim();
  
  if (!queryText) {
    return { 
      candidates: [], 
      childTitle: childMoment.title ?? null,
      childSummary: childMoment.summary ?? null,
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

  // 2.3 Anchor Query (SQLite)
  const anchorMoments = await findMomentsByAnchors(childMoment.anchors ?? [], {
    env: context.env,
    momentGraphNamespace: (context as any).momentGraphNamespace || null,
  });

  const anchorMatchIds = anchorMoments.map((m: Moment) => m.id);

  // 2.4 Predecessor Injection
  const predecessorMomentId = (childMoment.sourceMetadata as any)?.simulation?.predecessorMomentId;
  const predecessorMatchIds = typeof predecessorMomentId === "string" ? [predecessorMomentId] : [];

  // Merge anchor IDs and predecessor IDs into matchIds, prioritizing them in the list
  const mergedMatchIds = Array.from(new Set([...predecessorMatchIds, ...anchorMatchIds, ...matchIds]));

  // Rebuild matches list to include anchor matches and predecessors (giving them high synthetic scores)
  const mergedMatches = mergedMatchIds.map(id => {
    if (id === predecessorMomentId) {
      return { id, score: 1.0 }; // Highest priority
    }
    const vectorMatch = matches.find((m: { id: string, score: number | null }) => m.id === id);
    if (vectorMatch) {
      return vectorMatch;
    }
    // Synthetic match for anchor match not found in vector
    return { id, score: 0.95 }; // High score for explicit anchor match
  });

  // 3. Load candidate rows details from Moment Graph
  const candidateMoments = await getMoments(mergedMatchIds, {
    env: context.env,
    momentGraphNamespace: (context as any).momentGraphNamespace || null,
  });
  
  const candidateRowsById = new Map<string, any>(
    Array.from(candidateMoments.entries()).map(([id, r]: [string, Moment]) => [id, {
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
    matches: mergedMatches,
    candidateRowsById: candidateRowsById as any,
    maxCandidates,
  });

  if (context.logger) {
    await context.logger.info("candidate-sets.hybrid-retrieval", {
      momentId: childMoment.id,
      anchors: childMoment.anchors,
      anchorMatches: anchorMatchIds.length,
      vectorMatches: matches.length,
      mergedMatches: mergedMatches.length,
      finalCandidates: built.candidates.length
    });
  }

  const finalCandidates = built.candidates.map((c: any) => ({
    id: c.id,
    score: c.score,
    documentId: c.documentId,
    title: c.title,
    summary: (candidateRowsById.get(c.id) as any)?.summary || null,
    createdAt: (candidateRowsById.get(c.id) as any)?.created_at || c.createdAt,
    sourceMetadata: (candidateRowsById.get(c.id) as any)?.source_metadata || null,
    isPredecessor: c.id === predecessorMomentId,
  }));

  return {
    candidates: finalCandidates,
    childTitle: childMoment.title ?? null,
    childSummary: childMoment.summary ?? null,
    stats: {
      ...built.stats,
      vectorTopK,
    }
  };
}
