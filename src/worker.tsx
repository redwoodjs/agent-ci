import { defineApp } from "rwsdk/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { setCommonHeaders } from "./app/headers";

import { authRoutes } from "./app/pages/auth/routes";
import { sourceRoutes } from "./app/pages/sources/routes";
import { routes as discordRoutes } from "./app/pages/ingest/discord/routes";
import { routes as cursorIngestorRoutes } from "./app/ingestors/cursor/routes";
import { routes as githubIngestorRoutes } from "./app/ingestors/github/routes";
import { routes as ragRoutes } from "./app/engine/routes";
import { HomePage } from "./app/pages/HomePage";

export type AppContext = {
  user: any;
};

const app = defineApp([
  setCommonHeaders(),
  async function authMiddleware({ ctx, request }) {
    try {
      const session = await auth.api.getSession({
        headers: request.headers,
      });
      if (session?.user) {
        ctx.user = session.user;
      }
    } catch (error) {
      // console.error("Session error:", error);
    }
  },

  render(Document, [
    route("/", [HomePage]),

    prefix("/auth", authRoutes),
    prefix("/sources", sourceRoutes),
  ]),

  prefix("/ingest/discord", discordRoutes),
  prefix("/ingestors/cursor", cursorIngestorRoutes),
  prefix("/ingestors/github", githubIngestorRoutes),
  prefix("/rag", ragRoutes),
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { CursorEventsDurableObject } from "@/app/ingestors/cursor/db/durableObject";
export { GitHubRepoDurableObject } from "@/app/ingestors/github/db/durableObject";
export { GitHubBackfillStateDO } from "@/app/ingestors/github/db/backfill-durableObject";
export { EngineIndexingStateDO } from "@/app/engine/db/durableObject";

import { processSchedulerJob } from "@/app/ingestors/github/services/scheduler-service";
import { processProcessorJob } from "@/app/ingestors/github/services/processor-service";
import { handleDeadLetterMessage } from "@/app/ingestors/github/services/dlq-handler";
import { processIndexingJob } from "@/app/engine/services/indexing-worker";
import { processScannerJob } from "@/app/engine/services/scanner-service";
import type {
  QueueMessage,
  ProcessorJobMessage,
} from "@/app/ingestors/github/services/backfill-types";
import { formatLog } from "@/app/ingestors/github/utils/inspect";

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    const queueName = batch.queue;

    for (const message of batch.messages) {
      const queueMessage = message.body as QueueMessage;
      try {
        if (
          (queueName === "github-scheduler-queue" ||
            queueName === "github-scheduler-queue-prod" ||
            queueName === "SCHEDULER_QUEUE") &&
          queueMessage.type === "scheduler"
        ) {
          await processSchedulerJob(queueMessage);
          message.ack();
        } else if (
          (queueName === "github-processor-queue" ||
            queueName === "github-processor-queue-prod" ||
            queueName === "PROCESSOR_QUEUE") &&
          queueMessage.type === "processor"
        ) {
          await processProcessorJob(queueMessage);
          message.ack();
        } else if (
          (queueName === "github-processor-queue-dlq" ||
            queueName === "github-processor-queue-prod-dlq" ||
            queueName === "PROCESSOR_QUEUE_DLQ") &&
          queueMessage.type === "processor"
        ) {
          await handleDeadLetterMessage(queueMessage);
          message.ack();
        } else if (
          queueName === "engine-indexing-queue" ||
          queueName === "engine-indexing-queue-prod" ||
          queueName === "engine-indexing-queue-rag-experiment-1" ||
          queueName === "ENGINE_INDEXING_QUEUE"
        ) {
          const indexingMessage = queueMessage as unknown as { r2Key: string };
          console.log(
            `[queue] Received indexing job from ${queueName}:`,
            indexingMessage
          );
          await processIndexingJob(indexingMessage, env as Cloudflare.Env);
          message.ack();
        } else if (
          queueName === "r2-file-update-queue-rag-experiment-1"
        ) {
          const r2Event = queueMessage as unknown as {
            key: string;
            bucket: string;
            eventType: string;
          };
          console.log(
            `[r2-event] Received R2 event: ${r2Event.eventType} for ${r2Event.key}`
          );

          if (
            r2Event.key.endsWith("latest.json") &&
            (r2Event.eventType === "ObjectCreated" ||
              r2Event.eventType === "ObjectCreated:Copy")
          ) {
            if (env.ENGINE_INDEXING_QUEUE) {
              await env.ENGINE_INDEXING_QUEUE.send({
                body: { r2Key: r2Event.key },
              });
              console.log(
                `[r2-event] Enqueued ${r2Event.key} for indexing`
              );
            } else {
              console.error(
                `[r2-event] ENGINE_INDEXING_QUEUE binding not found`
              );
            }
          }
          message.ack();
        } else {
          console.error(
            formatLog("[queue] Unknown queue or message type:", {
              queueName,
              message: queueMessage,
            })
          );
          message.ack();
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        console.error(
          formatLog("[queue] Error processing message:", {
            queueName,
            message: queueMessage,
            error: errorMsg,
            stack: errorStack,
          })
        );
        message.retry();
      }
    }
  },
  async scheduled(event, env, ctx) {
    console.log(`[cron] Scheduled event triggered: ${event.cron}`);
    ctx.waitUntil(processScannerJob(env as Cloudflare.Env));
  },
} as ExportedHandler;
