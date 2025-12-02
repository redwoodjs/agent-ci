import { indexDocument, createEngineContext } from "../index";
import { updateIndexingState } from "../db";
import { Chunk } from "../types";

interface IndexingMessage {
  r2Key: string;
}

export async function processIndexingJob(
  message: IndexingMessage,
  env: Cloudflare.Env
): Promise<void> {
  const { r2Key } = message;

  console.log(`[indexing-scheduler] Starting job for R2 key: ${r2Key}`);

  try {
    // 1. Create engine context
    const context = createEngineContext(env, "indexing");

    // 2. Call indexDocument, which now only performs diffing and subject correlation
    // It returns only the chunks that are new or have been modified.
    console.log(
      `[indexing-scheduler] Step 1: Diffing document and finding new chunks for ${r2Key}`
    );
    const newChunks = await indexDocument(r2Key, context);

    if (newChunks.length === 0) {
      console.log(
        `[indexing-scheduler] No new chunks to process for ${r2Key}. Job complete.`
      );
      return;
    }

    console.log(
      `[indexing-scheduler] Step 2: Found ${newChunks.length} new chunks. Fanning out to CHUNK_PROCESSING_QUEUE.`
    );

    // 3. Fan-out: Enqueue each new chunk for parallel processing
    const messages = newChunks.map((chunk) => ({ body: chunk }));
    await env.CHUNK_PROCESSING_QUEUE.sendBatch(messages);

    console.log(
      `[indexing-scheduler] Step 3: Successfully enqueued ${newChunks.length} chunks for processing.`
    );

    // Note: The final state update (setProcessedChunkHashes) is now handled
    // within the indexDocument function itself, after the diffing stage.
    console.log(
      `[indexing-scheduler] Successfully completed scheduling for ${r2Key}`
    );
  } catch (error) {
    console.error(
      `[indexing-scheduler] Error processing indexing job for ${r2Key}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (error instanceof Error) {
      console.error(
        `[indexing-scheduler] Error stack: ${error.stack || "no stack"}`
      );
    }
    throw error;
  }
}
