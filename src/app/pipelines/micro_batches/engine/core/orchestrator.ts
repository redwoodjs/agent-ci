import type { Chunk, Document } from "../../../../engine/types";
import { PipelineContext } from "../../../../engine/runtime/types";
import { planMicroBatches } from "../../../../engine/lib/phaseCores/microBatchesCore";
import { getMicroPromptContext } from "../../../../engine/indexing/pluginPipeline";
import { getEmbeddings, getEmbedding } from "../../../../engine/utils/vector";
import { computeMicroMomentsForChunkBatch } from "../../../../engine/subjects/computeMicroMomentsForChunkBatch";
import { computeMicroItemsWithoutLlm } from "../../../../engine/utils/microItems";

async function sha256Hex(value: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(value);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type MicroMomentResult = {
  path: string;
  content: string;
  summary: string;
  embedding: number[];
  createdAt: string;
  author: string;
  sourceMetadata: Record<string, any>;
};

export async function computeMicroBatchesForDocument(input: {
  document: Document;
  context: PipelineContext;
  chunkBatches: Chunk[][];
  batchIndex?: number;
}): Promise<
  Array<{
    batchIndex: number;
    batchHash: string;
    promptContext: string;
    promptContextHash: string;
    chunks: Chunk[];
    cached: boolean;
    microItems: string[];
  }>
> {
  const { document, context, chunkBatches, batchIndex } = input;

  const planned = await planMicroBatches({
    document,
    indexingContext: context,
    plugins: context.plugins,
    chunkBatches,
    sha256Hex,
    getMicroPromptContext,
  });

  const out: Array<{
    batchIndex: number;
    batchHash: string;
    promptContext: string;
    promptContextHash: string;
    chunks: Chunk[];
    cached: boolean;
    microItems: string[];
  }> = [];

  for (const p of planned) {
    if (batchIndex !== undefined && p.batchIndex !== batchIndex) {
      continue;
    }

    const cached = await context.cache.get(p.batchHash, p.promptContextHash);

    if (cached) {
      out.push({
        batchIndex: p.batchIndex,
        batchHash: p.batchHash,
        promptContext: p.promptContext,
        promptContextHash: p.promptContextHash,
        chunks: p.chunks,
        cached: true,
        microItems: cached.microItems,
      });
      continue;
    }

    let microItems: string[] = [];
    try {
      const computed = await computeMicroMomentsForChunkBatch(p.chunks, {
        promptContext: p.promptContext,
      });
      microItems = computed ?? [];
    } catch {
      microItems = [];
    }

    if (!Array.isArray(microItems) || microItems.length === 0) {
      microItems = computeMicroItemsWithoutLlm(p.chunks);
    }

    await context.cache.set(
      p.batchHash,
      p.promptContextHash,
      microItems,
      p.chunks,
      p.batchIndex,
      p.promptContext
    );

    out.push({
      batchIndex: p.batchIndex,
      batchHash: p.batchHash,
      promptContext: p.promptContext,
      promptContextHash: p.promptContextHash,
      chunks: p.chunks,
      cached: false,
      microItems,
    });
  }

  return out;
}

function parseDateMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function inferBatchTimeRange(
  chunks: any[],
  documentCreatedAt: string,
  now: string
): { start: string; end: string } {
  let minMs: number | null = null;
  let maxMs: number | null = null;

  for (const chunk of chunks) {
    const ts = (chunk?.metadata as any)?.timestamp;
    const ms = parseDateMs(ts);
    if (ms === null) {
      continue;
    }
    if (minMs === null || ms < minMs) {
      minMs = ms;
    }
    if (maxMs === null || ms > maxMs) {
      maxMs = ms;
    }
  }

  const fallbackMs =
    parseDateMs(documentCreatedAt) ?? parseDateMs(now) ?? Date.now();
  const startMs = minMs ?? fallbackMs;
  const endMs = maxMs ?? startMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export async function runMicroBatchesForDocument(input: {
  document: Document;
  context: PipelineContext;
  chunkBatches: Chunk[][];
  now: string;
  batchIndex?: number;
}): Promise<{
  batches: Array<{
    batchIndex: number;
    batchHash: string;
    promptContext: string;
    promptContextHash: string;
    chunks: Chunk[];
    cached: boolean;
    microItems: string[];
  }>;
  microMoments: MicroMomentResult[];
}> {
  const { document, context, chunkBatches, now, batchIndex } = input;

  const batches = await computeMicroBatchesForDocument({
    document,
    context,
    chunkBatches,
    batchIndex,
  });

  const microMoments: MicroMomentResult[] = [];

  for (const b of batches) {
    const microItems = Array.isArray(b.microItems) ? b.microItems : [];
    if (microItems.length === 0) {
      continue;
    }

    const prefix = `chunk-batch:${b.batchHash}:`;

    let embeddings: number[][] = [];
    try {
      embeddings = await getEmbeddings(microItems);
    } catch {
      embeddings = [];
    }

    const docCreatedAtRaw = (document as any)?.metadata?.createdAt;
    const docCreatedAt =
      typeof docCreatedAtRaw === "string" && docCreatedAtRaw.trim().length > 0
        ? docCreatedAtRaw.trim()
        : now;
    const batchTimeRange = inferBatchTimeRange(
      b.chunks as any[],
      docCreatedAt,
      now
    );

    const batchAuthorRaw = (b.chunks?.[0]?.metadata as any)?.author;
    const docAuthorRaw = (document as any)?.metadata?.author;
    const batchAuthor =
      typeof batchAuthorRaw === "string" && batchAuthorRaw.trim().length > 0
        ? batchAuthorRaw.trim()
        : typeof docAuthorRaw === "string" && docAuthorRaw.trim().length > 0
          ? docAuthorRaw.trim()
          : "unknown";

    for (let i = 0; i < microItems.length; i++) {
        const text = microItems[i] ?? "";
        const embedding = embeddings[i] ?? (await getEmbedding(text));
        
        microMoments.push({
            path: `${prefix}${i + 1}`,
            content: text,
            summary: text,
            embedding,
            createdAt: batchTimeRange.start,
            author: batchAuthor,
            sourceMetadata: {
                chunkBatchHash: b.batchHash,
                chunkIds: (b.chunks ?? []).map((c: any) => c.id).filter(Boolean),
                timeRange: batchTimeRange,
            },
        });
    }
  }

  return { batches, microMoments };
}
