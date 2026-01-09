import { indexDocument, createEngineContext } from "../index";
import { updateIndexingState } from "../db";
import { Chunk } from "../types";
import { markDocumentCollected, setReplayEnqueued } from "../db/momentReplay";
import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";

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

  try {
    const context = createEngineContext(env, "indexing");
    const newChunks = await indexDocument(r2Key, context, {
      momentGraphNamespace: momentGraphNamespace ?? null,
      momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
      momentReplayRunId:
        jobType === "moment-replay-collect" && momentReplayRunId
          ? momentReplayRunId
          : null,
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

    if (jobType === "moment-replay-collect" && momentReplayRunId) {
      const effectiveNamespace =
        momentGraphNamespace && momentGraphNamespacePrefix
          ? applyMomentGraphNamespacePrefixValue(
              momentGraphNamespace,
              momentGraphNamespacePrefix
            )
          : momentGraphNamespace ?? null;
      const runState = await markDocumentCollected(
        { env, momentGraphNamespace: effectiveNamespace },
        { runId: momentReplayRunId }
      );

      if (
        runState &&
        !runState.replayEnqueued &&
        runState.collectedDocuments >= runState.expectedDocuments
      ) {
        const didMark = await setReplayEnqueued(
          { env, momentGraphNamespace: effectiveNamespace },
          { runId: momentReplayRunId }
        );
        if (didMark && (env as any).ENGINE_INDEXING_QUEUE) {
          await (env as any).ENGINE_INDEXING_QUEUE.send({
            jobType: "moment-replay-replay",
            momentReplayRunId,
            momentGraphNamespace: momentGraphNamespace ?? null,
            momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
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
    throw error;
  }
}
