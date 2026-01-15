import type { Chunk, Document, IndexingHookContext, Plugin } from "../../../types";
import type { MicroBatchPlanItem } from "../../../lib/phaseCores/micro_batches_core";

export type MicroBatchesOrchestratorPorts = {
  planMicroBatches: (input: {
    document: Document;
    indexingContext: IndexingHookContext;
    plugins: Plugin[];
    chunkBatches: Chunk[][];
    sha256Hex: (value: string) => Promise<string>;
    getMicroPromptContext: (
      document: Document,
      chunks: Chunk[],
      indexingContext: IndexingHookContext,
      plugins: Plugin[]
    ) => Promise<string>;
  }) => Promise<MicroBatchPlanItem[]>;
  sha256Hex: (value: string) => Promise<string>;
  getMicroPromptContext: (
    document: Document,
    chunks: Chunk[],
    indexingContext: IndexingHookContext,
    plugins: Plugin[]
  ) => Promise<string>;
  loadMicroBatchCache: (input: {
    batchHash: string;
    promptContextHash: string;
  }) => Promise<{ microItems: string[] } | null>;
  storeMicroBatchCache: (input: {
    batchHash: string;
    promptContextHash: string;
    microItems: string[];
    chunks: Chunk[];
    batchIndex: number;
    promptContext: string;
  }) => Promise<void>;
  computeMicroItemsForChunkBatch: (input: {
    chunks: Chunk[];
    promptContext: string;
  }) => Promise<string[]>;
  fallbackMicroItemsForChunkBatch: (input: { chunks: Chunk[] }) => string[];
  getEmbeddings: (texts: string[]) => Promise<number[][]>;
  getEmbedding: (text: string) => Promise<number[]>;
  upsertMicroMomentsBatch: (input: {
    documentId: string;
    momentGraphNamespace: string | null;
    microMoments: Array<{
      path: string;
      content: string;
      summary: string;
      embedding: number[];
      createdAt: string;
      author: string;
      sourceMetadata: Record<string, any>;
    }>;
  }) => Promise<void>;
};

export async function computeMicroBatchesForDocument(input: {
  ports: MicroBatchesOrchestratorPorts;
  document: Document;
  indexingContext: IndexingHookContext;
  plugins: Plugin[];
  chunkBatches: Chunk[][];
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
  const planned = await input.ports.planMicroBatches({
    document: input.document,
    indexingContext: input.indexingContext,
    plugins: input.plugins,
    chunkBatches: input.chunkBatches,
    sha256Hex: input.ports.sha256Hex,
    getMicroPromptContext: input.ports.getMicroPromptContext,
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
    const cached = await input.ports.loadMicroBatchCache({
      batchHash: p.batchHash,
      promptContextHash: p.promptContextHash,
    });

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
      microItems = await input.ports.computeMicroItemsForChunkBatch({
        chunks: p.chunks,
        promptContext: p.promptContext,
      });
    } catch {
      microItems = [];
    }

    if (!Array.isArray(microItems) || microItems.length === 0) {
      microItems = input.ports.fallbackMicroItemsForChunkBatch({
        chunks: p.chunks,
      });
    }

    await input.ports.storeMicroBatchCache({
      batchHash: p.batchHash,
      promptContextHash: p.promptContextHash,
      microItems,
      chunks: p.chunks,
      batchIndex: p.batchIndex,
      promptContext: p.promptContext,
    });

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

  const fallbackMs = parseDateMs(documentCreatedAt) ?? parseDateMs(now) ?? Date.now();
  const startMs = minMs ?? fallbackMs;
  const endMs = maxMs ?? startMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
  };
}

export async function runMicroBatchesForDocument(input: {
  ports: MicroBatchesOrchestratorPorts;
  document: Document;
  indexingContext: IndexingHookContext;
  plugins: Plugin[];
  chunkBatches: Chunk[][];
  now: string;
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
  microMomentsUpserted: number;
}> {
  const batches = await computeMicroBatchesForDocument({
    ports: input.ports,
    document: input.document,
    indexingContext: input.indexingContext,
    plugins: input.plugins,
    chunkBatches: input.chunkBatches,
  });

  let microMomentsUpserted = 0;

  for (const b of batches) {
    const microItems = Array.isArray(b.microItems) ? b.microItems : [];
    if (microItems.length === 0) {
      continue;
    }

    const prefix = `chunk-batch:${b.batchHash}:`;

    let embeddings: number[][] = [];
    try {
      embeddings = await input.ports.getEmbeddings(microItems);
    } catch {
      embeddings = [];
    }

    const docCreatedAtRaw = (input.document as any)?.metadata?.createdAt;
    const docCreatedAt =
      typeof docCreatedAtRaw === "string" && docCreatedAtRaw.trim().length > 0
        ? docCreatedAtRaw.trim()
        : input.now;
    const batchTimeRange = inferBatchTimeRange(b.chunks as any[], docCreatedAt, input.now);

    const batchAuthorRaw = (b.chunks?.[0]?.metadata as any)?.author;
    const docAuthorRaw = (input.document as any)?.metadata?.author;
    const batchAuthor =
      typeof batchAuthorRaw === "string" && batchAuthorRaw.trim().length > 0
        ? batchAuthorRaw.trim()
        : typeof docAuthorRaw === "string" && docAuthorRaw.trim().length > 0
        ? docAuthorRaw.trim()
        : "unknown";

    const microMoments: Array<{
      path: string;
      content: string;
      summary: string;
      embedding: number[];
      createdAt: string;
      author: string;
      sourceMetadata: Record<string, any>;
    }> = [];

    for (let i = 0; i < microItems.length; i++) {
      const text = microItems[i] ?? "";
      const embedding = embeddings[i] ?? (await input.ports.getEmbedding(text));
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

    await input.ports.upsertMicroMomentsBatch({
      documentId: input.document.id,
      momentGraphNamespace: input.indexingContext.momentGraphNamespace ?? null,
      microMoments,
    });
    microMomentsUpserted += microMoments.length;
  }

  return { batches, microMomentsUpserted };
}

