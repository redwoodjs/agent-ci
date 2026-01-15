import type { Chunk, Document, IndexingHookContext, Plugin } from "../../index";

export type MicroBatchPlanItem = {
  batchIndex: number;
  batchHash: string;
  promptContext: string;
  promptContextHash: string;
  chunks: Chunk[];
};

export async function planMicroBatches(input: {
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
}): Promise<MicroBatchPlanItem[]> {
  const out: MicroBatchPlanItem[] = [];

  for (
    let batchIndex = 0;
    batchIndex < input.chunkBatches.length;
    batchIndex++
  ) {
    const batchChunks = input.chunkBatches[batchIndex] ?? [];
    const batchKeyParts = batchChunks.map((c) => {
      const hash = c.contentHash ?? "";
      return `${c.id}:${hash}`;
    });
    const batchHash = await input.sha256Hex(batchKeyParts.join("\n"));

    const promptContext = await input.getMicroPromptContext(
      input.document,
      batchChunks,
      input.indexingContext,
      input.plugins
    );
    const promptContextHash = await input.sha256Hex(promptContext);

    out.push({
      batchIndex,
      batchHash,
      promptContext,
      promptContextHash,
      chunks: batchChunks,
    });
  }

  return out;
}

