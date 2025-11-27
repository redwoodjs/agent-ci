import { defineApp } from "rwsdk/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { setCommonHeaders } from "./app/headers";

import { auditRoutes } from "./app/pages/audit/routes";
import { routes as discordRoutes } from "./app/ingestors/discord/routes";
import { routes as cursorIngestorRoutes } from "./app/ingestors/cursor/routes";
import { routes as githubIngestorRoutes } from "./app/ingestors/github/routes";
import { routes as ragRoutes } from "./app/engine/routes";
import { HomePage } from "./app/pages/HomePage";

export type AppContext = {
  user: any;
};

const app = defineApp([
  setCommonHeaders(),

  render(Document, [route("/", [HomePage]), prefix("/audit", auditRoutes)]),

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
export { DiscordBackfillStateDO } from "@/app/ingestors/discord/db/backfill-durableObject";
export { DiscordWebhookBatcherDO } from "@/app/ingestors/discord/db/webhook-batcher-durableObject";

import { processSchedulerJob } from "@/app/ingestors/github/services/scheduler-service";
import { processProcessorJob } from "@/app/ingestors/github/services/processor-service";
import { handleDeadLetterMessage } from "@/app/ingestors/github/services/dlq-handler";
import { processSchedulerJob as processDiscordSchedulerJob } from "@/app/ingestors/discord/services/scheduler-service";
import { processProcessorJob as processDiscordProcessorJob } from "@/app/ingestors/discord/services/processor-service";
import { handleDeadLetterMessage as handleDiscordDeadLetterMessage } from "@/app/ingestors/discord/services/dlq-handler";
import { processIndexingJob } from "@/app/engine/services/indexing-worker";
import { processScannerJob } from "@/app/engine/services/scanner-service";
import type {
  QueueMessage,
  ProcessorJobMessage,
} from "@/app/ingestors/github/services/backfill-types";
import type { QueueMessage as DiscordQueueMessage } from "@/app/ingestors/discord/services/backfill-types";
import { formatLog } from "@/app/ingestors/github/utils/inspect";

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    const queueName = batch.queue;
    console.log(
      `[queue] Processing batch from queue: ${queueName}, batch size: ${batch.messages.length}`
    );

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
          const indexingMessage = queueMessage as unknown as {
            r2Key?: string;
            body?: { r2Key?: string };
          };
          const r2Key = indexingMessage.r2Key || indexingMessage.body?.r2Key;
          console.log(`[queue] Received indexing job from ${queueName}:`, {
            r2Key,
            rawMessage: indexingMessage,
          });
          if (!r2Key) {
            console.error(
              formatLog("[queue] Missing r2Key in indexing message:", {
                queueName,
                message: indexingMessage,
              })
            );
            message.ack();
            continue;
          }
          await processIndexingJob({ r2Key }, env as Cloudflare.Env);
          message.ack();
        } else if (queueName.startsWith("discord-scheduler-queue")) {
          const discordMessage = queueMessage as unknown as DiscordQueueMessage;
          if (discordMessage.type === "scheduler") {
            await processDiscordSchedulerJob(discordMessage);
            message.ack();
          } else {
            console.error(
              formatLog("[queue] Invalid Discord scheduler message type:", {
                queueName,
                message: discordMessage,
              })
            );
            message.ack();
          }
        } else if (
          queueName.startsWith("discord-processor-queue") &&
          !queueName.includes("-dlq")
        ) {
          const discordMessage = queueMessage as unknown as DiscordQueueMessage;
          if (discordMessage.type === "processor") {
            await processDiscordProcessorJob(discordMessage);
            message.ack();
          } else {
            console.error(
              formatLog("[queue] Invalid Discord processor message type:", {
                queueName,
                message: discordMessage,
              })
            );
            message.ack();
          }
        } else if (
          queueName.includes("discord-processor-queue") &&
          queueName.includes("-dlq")
        ) {
          const discordMessage = queueMessage as unknown as DiscordQueueMessage;
          if (discordMessage.type === "processor") {
            await handleDiscordDeadLetterMessage(discordMessage);
            message.ack();
          } else {
            console.error(
              formatLog("[queue] Invalid Discord DLQ message type:", {
                queueName,
                message: discordMessage,
              })
            );
            message.ack();
          }
        } else if (queueName.startsWith("r2-file-update-queue-")) {
          const r2Event = queueMessage as unknown as {
            action: string;
            bucket: string;
            object?: {
              key: string;
              size?: number;
              eTag?: string;
            };
          };

          const r2Key = r2Event.object?.key;
          const eventType =
            r2Event.action === "PutObject" ? "ObjectCreated" : r2Event.action;

          console.log(
            `[r2-event] Received R2 event: ${eventType} for ${r2Key}`
          );

          if (
            r2Key &&
            (r2Key.endsWith("latest.json") ||
              (r2Key.startsWith("discord/") && r2Key.endsWith(".jsonl"))) &&
            (eventType === "ObjectCreated" ||
              eventType === "ObjectCreated:Copy")
          ) {
            const envCloudflare = env as Cloudflare.Env;
            if (envCloudflare.ENGINE_INDEXING_QUEUE) {
              console.log(
                `[r2-event] Sending to ENGINE_INDEXING_QUEUE binding with r2Key: ${r2Key}`
              );
              await envCloudflare.ENGINE_INDEXING_QUEUE.send({
                body: { r2Key },
              });
              console.log(
                `[r2-event] Successfully enqueued ${r2Key} for indexing`
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
