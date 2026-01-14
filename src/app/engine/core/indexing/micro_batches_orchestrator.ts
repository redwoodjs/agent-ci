import type { Chunk, Document, IndexingHookContext, Plugin } from "../../types";
import type { MicroBatchPlanItem } from "../../lib/phaseCores/micro_batches_core";
import { computeMicroItemsWithoutLlm } from "../../utils/microItems";

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
  }) => Promise<void>;
  computeMicroItemsForChunkBatch: (input: {
    chunks: Chunk[];
    promptContext: string;
  }) => Promise<string[]>;
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
      microItems = computeMicroItemsWithoutLlm(p.chunks);
    }

    await input.ports.storeMicroBatchCache({
      batchHash: p.batchHash,
      promptContextHash: p.promptContextHash,
      microItems,
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

