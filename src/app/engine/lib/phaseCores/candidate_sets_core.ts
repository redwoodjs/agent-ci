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
    if (row.document_id === input.childDocumentId) {
      filtered.sameDoc++;
      continue;
    }

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

