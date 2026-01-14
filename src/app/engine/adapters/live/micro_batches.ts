import type { Document, Chunk, IndexingHookContext, Plugin } from "../../types";
import { planMicroBatches } from "../../lib/phaseCores/micro_batches_core";

export async function planIndexDocumentMicroBatches(input: {
  document: Document;
  indexingContext: IndexingHookContext;
  plugins: Plugin[];
  chunkBatches: Chunk[][];
  hashStrings: (values: string[]) => Promise<string>;
}): Promise<
  Array<{
    batchIndex: number;
    batchHash: string;
    promptContext: string;
    promptContextHash: string;
    batchChunks: Chunk[];
  }>
> {
  async function sha256Hex(value: string): Promise<string> {
    return await input.hashStrings([value]);
  }

  async function getMicroPromptContext(
    document: Document,
    chunks: Chunk[],
    indexingContext: IndexingHookContext,
    plugins: Plugin[]
  ): Promise<string> {
    for (const plugin of plugins) {
      const v =
        await plugin.subjects?.getMicroMomentBatchPromptContext?.(
          document,
          chunks,
          indexingContext
        );
      if (v !== null && v !== undefined) {
        return v;
      }
    }
    return (
      `Context: These chunks are from a single document.\n` +
      `Focus on concrete details and avoid generic summaries.\n`
    );
  }

  const planned = await planMicroBatches({
    document: input.document,
    indexingContext: input.indexingContext,
    plugins: input.plugins,
    chunkBatches: input.chunkBatches,
    sha256Hex,
    getMicroPromptContext,
  });

  return planned.map((p) => ({
    batchIndex: p.batchIndex,
    batchHash: p.batchHash,
    promptContext: p.promptContext,
    promptContextHash: p.promptContextHash,
    batchChunks: p.chunks,
  }));
}

