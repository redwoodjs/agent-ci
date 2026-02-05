import { createEngineContext } from "../index";
import { IngestDiffPhase } from "../../pipelines/ingest_diff";
import { executePhase } from "../runtime/orchestrator";
import { NoOpStorage, QueueTransition } from "../runtime/strategies/live";
import {
  recordReplayDocumentResult,
  setReplayEnqueued,
} from "../databases/indexingState/momentReplay";

interface IndexingMessage {
  r2Key: string;
  momentGraphNamespace?: string;
  momentGraphNamespacePrefix?: string;
  momentReplayRunId?: string;
  jobType?: string;
  forceRecollect?: boolean;
  phase?: string;
  input?: any;
}

import { getPhaseByName } from "../../pipelines/registry";

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

  async function maybeEnqueueReplay(runId: string, runState: NonNullable<Awaited<ReturnType<typeof recordReplayDocumentResult>>>) {
    if (runState.replayEnqueued) {
      return;
    }
    if (runState.processedDocuments < runState.expectedDocuments) {
      return;
    }
    const queue = (env as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return;
    }
    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });
    await setReplayEnqueued({ env, momentGraphNamespace: null }, { runId });
  }

  try {
    if (jobType === "execute_phase") {
      const phaseName = message.phase;
      const phaseInput = message.input;
      if (!phaseName) {
        throw new Error("Missing phase name for execute_phase job");
      }

      console.log(`[indexing-scheduler] Executing phase: ${phaseName} for ${r2Key}`);
      const phaseDef = getPhaseByName(phaseName);
      if (!phaseDef) {
        throw new Error(`Unknown phase: ${phaseName}`);
      }

      const strategies = {
        storage: new NoOpStorage(),
        transition: new QueueTransition((env as any).ENGINE_INDEXING_QUEUE),
      };

      const pipelineContext: any = {
        ...createEngineContext(env, "indexing"),
        r2Key,
        momentGraphNamespace: momentGraphNamespace ?? null,
      };

      await executePhase(phaseDef, phaseInput, strategies, pipelineContext);
      return;
    }

    const strategies = {
      storage: new NoOpStorage(),
      transition: new QueueTransition((env as any).ENGINE_INDEXING_QUEUE),
    };

    const pipelineContext: any = {
      ...createEngineContext(env, "indexing"),
      r2Key,
      momentGraphNamespace: momentGraphNamespace ?? null,
    };

    const output = await executePhase(
      IngestDiffPhase,
      r2Key,
      strategies,
      pipelineContext
    );

    console.log(
      `[indexing-scheduler] Completed ingest_diff for ${r2Key}. Changed: ${output?.changed}`
    );

    if (isReplayCollect) {
      const runState = await recordReplayDocumentResult(
        { env, momentGraphNamespace: null },
        { runId: momentReplayRunId!, r2Key, status: "succeeded" }
      );

      if (runState) {
        await maybeEnqueueReplay(momentReplayRunId!, runState);
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
          ...(jobType ? { jobType } : {}),
          ...(message.phase ? { phase: message.phase } : {}),
          ...(message.input ? { input: message.input } : {}),
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
