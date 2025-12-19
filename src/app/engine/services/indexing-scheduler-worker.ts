import { indexDocument, createEngineContext } from "../index";
import { updateIndexingState } from "../db";
import { Chunk } from "../types";

interface IndexingMessage {
  r2Key: string;
  momentGraphNamespace?: string;
  momentGraphNamespacePrefix?: string;
}

export async function processIndexingJob(
  message: IndexingMessage,
  env: Cloudflare.Env
): Promise<void> {
  const { r2Key, momentGraphNamespace, momentGraphNamespacePrefix } = message;

  try {
    const context = createEngineContext(env, "indexing");
    const newChunks = await indexDocument(r2Key, context, {
      momentGraphNamespace: momentGraphNamespace ?? null,
      momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
    });

    if (newChunks.length === 0) {
      return;
    }

    const messages = newChunks.map((chunk) => ({ body: chunk }));
    const batchSize = 100;
    for (let i = 0; i < messages.length; i += batchSize) {
      const batch = messages.slice(i, i + batchSize);
      await env.CHUNK_PROCESSING_QUEUE.sendBatch(batch);
    }
    console.log(
      `[indexing-scheduler] Enqueued ${newChunks.length} chunks for ${r2Key}`
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
