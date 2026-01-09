import { indexDocument, createEngineContext } from "../index";
import { updateIndexingState } from "../db";
import { Chunk } from "../types";
import {
  recordReplayDocumentResult,
  setReplayEnqueued,
} from "../db/momentReplay";

interface IndexingMessage {
  r2Key: string;
  momentGraphNamespace?: string;
  momentGraphNamespacePrefix?: string;
  momentReplayRunId?: string;
  jobType?: string;
}

export async function processIndexingJob(
  message: IndexingMessage,
  env: Cloudflare.Env
): Promise<void> {
  const {
    r2Key,
    momentGraphNamespace,
    momentGraphNamespacePrefix,
    momentReplayRunId,
    jobType,
  } = message;

  const isReplayCollect =
    jobType === "moment-replay-collect" && Boolean(momentReplayRunId);

  try {
    const context = createEngineContext(env, "indexing");
    const newChunks = await indexDocument(r2Key, context, {
      momentGraphNamespace: momentGraphNamespace ?? null,
      momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
      momentReplayRunId: isReplayCollect ? momentReplayRunId! : null,
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

    if (isReplayCollect) {
      const runState = await recordReplayDocumentResult(
        { env, momentGraphNamespace: null },
        { runId: momentReplayRunId!, r2Key, status: "succeeded" }
      );

      if (
        runState &&
        !runState.replayEnqueued &&
        runState.processedDocuments >= runState.expectedDocuments
      ) {
        const didMark = await setReplayEnqueued(
          { env, momentGraphNamespace: null },
          { runId: momentReplayRunId! }
        );
        if (didMark && (env as any).ENGINE_INDEXING_QUEUE) {
          await (env as any).ENGINE_INDEXING_QUEUE.send({
            jobType: "moment-replay-replay",
            momentReplayRunId,
          });
        }
      }
    }
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
    if (isReplayCollect && momentReplayRunId) {
      await recordReplayDocumentResult(
        { env, momentGraphNamespace: null },
        {
          runId: momentReplayRunId,
          r2Key,
          status: "failed",
          errorPayload: {
            message: error instanceof Error ? error.message : String(error),
          },
        }
      );
      return;
    }

    throw error;
  }
}
