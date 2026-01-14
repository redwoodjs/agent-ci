import type { MomentGraphContext } from "../../databases/momentGraph";
import { findDescendants, getMomentsForDocument } from "../../databases/momentGraph";
import type { Moment } from "../../types";

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

function pickThreadHeadAsOf(input: {
  moments: Moment[];
  asOfMs: number | null;
}): Moment | null {
  const asOf = input.asOfMs ?? Number.POSITIVE_INFINITY;
  let best: { ms: number; id: string; moment: Moment } | null = null;
  for (const m of input.moments) {
    const ms =
      computeMomentStartMs({
        createdAt: m.createdAt,
        sourceMetadata: m.sourceMetadata,
      }) ?? null;
    if (ms === null) {
      continue;
    }
    if (ms > asOf) {
      continue;
    }
    if (!best) {
      best = { ms, id: m.id, moment: m };
      continue;
    }
    if (ms > best.ms || (ms === best.ms && m.id.localeCompare(best.id) > 0)) {
      best = { ms, id: m.id, moment: m };
    }
  }
  return best?.moment ?? null;
}

export async function resolveThreadHeadForDocumentAsOf(input: {
  documentId: string;
  asOfMs: number | null;
  context: MomentGraphContext;
}): Promise<{ anchorMomentId: string | null; headMomentId: string | null }> {
  const first = await getMomentsForDocument(input.documentId, input.context, {
    limit: 1,
    offset: 0,
  });
  const anchor = first[0] ?? null;
  if (!anchor) {
    return { anchorMomentId: null, headMomentId: null };
  }

  const descendants = await findDescendants(anchor.id, input.context);
  const head = pickThreadHeadAsOf({
    moments: descendants,
    asOfMs: input.asOfMs,
  });

  return {
    anchorMomentId: anchor.id,
    headMomentId: head?.id ?? anchor.id,
  };
}

