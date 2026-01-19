import type { Document } from "../types";
import type { MicroMoment } from "../databases/momentGraph";

export function buildParsedDocumentIdentity(document: Document): Record<string, any> {
  return {
    documentId: document.id,
    source: document.source,
    type: document.type,
    url: document.metadata?.url ?? null,
    identity: (document.metadata as any)?.sourceMetadata ?? null,
  };
}

export function computeTimeRangeFromMicroMoments(input: {
  microMoments: Array<Pick<MicroMoment, "path" | "createdAt">>;
  microPaths: string[];
}): { start: string; end: string } | null {
  const wanted = new Set(
    Array.isArray(input.microPaths)
      ? input.microPaths.filter((p) => typeof p === "string" && p.length > 0)
      : []
  );
  if (wanted.size === 0) {
    return null;
  }

  let min: number | null = null;
  let max: number | null = null;

  for (const mm of input.microMoments) {
    if (!wanted.has(mm.path)) {
      continue;
    }
    const ms = Date.parse(mm.createdAt);
    if (!Number.isFinite(ms)) {
      continue;
    }
    if (min === null || ms < min) {
      min = ms;
    }
    if (max === null || ms > max) {
      max = ms;
    }
  }

  if (min === null) {
    return null;
  }
  const endMs = max ?? min;
  return { start: new Date(min).toISOString(), end: new Date(endMs).toISOString() };
}

export function mergeMomentSourceMetadata(input: {
  existing: unknown;
  parsedDocumentIdentity: Record<string, any>;
  timeRange: { start: string; end: string } | null;
}): Record<string, any> {
  const base =
    input.existing && typeof input.existing === "object"
      ? (input.existing as Record<string, any>)
      : {};

  const out: Record<string, any> = {
    ...base,
    document: base.document ?? input.parsedDocumentIdentity,
  };

  if (!out.timeRange && input.timeRange) {
    out.timeRange = input.timeRange;
  }

  return out;
}

