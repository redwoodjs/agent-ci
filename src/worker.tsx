import { defineApp } from "rwsdk/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { setCommonHeaders } from "./app/headers";

import { auditRoutes } from "./app/pages/audit/routes";
import { routes as discordRoutes } from "./app/ingestors/discord/routes";
import { routes as cursorIngestorRoutes } from "./app/ingestors/cursor/routes";
import { routes as githubIngestorRoutes } from "./app/ingestors/github/routes";
import { routes as engineRoutes } from "./app/engine/routes";
import { HomePage } from "./app/pages/HomePage";

export type AppContext = {
  user: any;
};

const app = defineApp([
  setCommonHeaders(),

  render(Document, [route("/", [HomePage]), prefix("/audit", auditRoutes)]),

  prefix("/ingestors/discord", discordRoutes),
  prefix("/ingestors/cursor", cursorIngestorRoutes),
  prefix("/ingestors/github", githubIngestorRoutes),

  // Engine endpoints live at their top-level paths (e.g. /query, /admin/index, /admin/resync).
  ...engineRoutes,
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { CursorEventsDurableObject } from "@/app/ingestors/cursor/db/durableObject";
export { GitHubRepoDurableObject } from "@/app/ingestors/github/db/durableObject";
export { GitHubBackfillStateDO } from "@/app/ingestors/github/db/backfill-durableObject";
export { EngineIndexingStateDO } from "@/app/engine/db/durableObject";
export { DiscordBackfillStateDO } from "@/app/ingestors/discord/db/backfill-durableObject";
export { SubjectDO } from "@/app/engine/subjectDb/durableObject";
// Temporary export for migration - will be removed after v8 migration completes
export { SubjectDO as SubjectGraphDO } from "@/app/engine/subjectDb/durableObject";
export { MomentGraphDO } from "@/app/engine/momentDb/durableObject";
export { DiscordWebhookBatcherDO } from "@/app/ingestors/discord/db/webhook-batcher-durableObject";

import { processSchedulerJob } from "@/app/ingestors/github/services/scheduler-service";
import { processProcessorJob } from "@/app/ingestors/github/services/processor-service";
import { handleDeadLetterMessage } from "@/app/ingestors/github/services/dlq-handler";
import { processSchedulerJob as processDiscordSchedulerJob } from "@/app/ingestors/discord/services/scheduler-service";
import { processProcessorJob as processDiscordProcessorJob } from "@/app/ingestors/discord/services/processor-service";
import { handleDeadLetterMessage as handleDiscordDeadLetterMessage } from "@/app/ingestors/discord/services/dlq-handler";
import { handleWebhookEvent } from "@/app/ingestors/discord/services/webhook-handler";
import { processIndexingJob } from "@/app/engine/services/indexing-scheduler-worker";
import { processChunkJob } from "@/app/engine/services/chunk-processor-worker";
import { processScannerJob } from "@/app/engine/services/scanner-service";
import type { QueueMessage } from "@/app/ingestors/github/services/backfill-types";
import type { QueueMessage as DiscordQueueMessage } from "@/app/ingestors/discord/services/backfill-types";
import { formatLog } from "@/app/ingestors/github/utils/inspect";
import { Chunk } from "./app/engine/types";

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
          queueName === "engine-indexing-queue-dev-justin" ||
          queueName === "engine-indexing-queue-rag-experiment-1" ||
          queueName === "ENGINE_INDEXING_QUEUE"
        ) {
          const indexingMessage = queueMessage as unknown as {
            r2Key?: unknown;
            r2Keys?: unknown;
            momentGraphNamespace?: unknown;
            namespace?: unknown;
            momentGraphNamespacePrefix?: unknown;
            namespacePrefix?: unknown;
            body?: {
              r2Key?: unknown;
              r2Keys?: unknown;
              momentGraphNamespace?: unknown;
              namespace?: unknown;
              momentGraphNamespacePrefix?: unknown;
              namespacePrefix?: unknown;
            };
          };

          const r2KeysRaw =
            indexingMessage.r2Keys ?? indexingMessage.body?.r2Keys;
          const r2KeyRaw = indexingMessage.r2Key ?? indexingMessage.body?.r2Key;
          const r2Keys =
            Array.isArray(r2KeysRaw) &&
            r2KeysRaw.every((k) => typeof k === "string")
              ? (r2KeysRaw as string[])
              : typeof r2KeyRaw === "string"
              ? [r2KeyRaw]
              : null;

          const namespaceRaw = (indexingMessage.momentGraphNamespace ??
            indexingMessage.namespace ??
            indexingMessage.body?.momentGraphNamespace ??
            indexingMessage.body?.namespace) as unknown;
          const momentGraphNamespace =
            typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
              ? namespaceRaw.trim()
              : null;

          const namespacePrefixRaw =
            (indexingMessage.momentGraphNamespacePrefix ??
              indexingMessage.namespacePrefix ??
              indexingMessage.body?.momentGraphNamespacePrefix ??
              indexingMessage.body?.namespacePrefix) as unknown;
          const momentGraphNamespacePrefix =
            typeof namespacePrefixRaw === "string" &&
            namespacePrefixRaw.trim().length > 0
              ? namespacePrefixRaw.trim()
              : null;

          console.log(`[queue] Received indexing job from ${queueName}:`, {
            r2KeysCount: r2Keys?.length ?? 0,
            momentGraphNamespace: momentGraphNamespace ?? null,
            momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
          });

          if (!r2Keys || r2Keys.length === 0) {
            console.error(
              formatLog("[queue] Missing r2Key in indexing message:", {
                queueName,
                message: indexingMessage,
              })
            );
            message.ack();
            continue;
          }

          try {
            for (const r2Key of r2Keys) {
              await processIndexingJob(
                {
                  r2Key,
                  ...(momentGraphNamespace ? { momentGraphNamespace } : null),
                  ...(momentGraphNamespacePrefix
                    ? { momentGraphNamespacePrefix }
                    : null),
                },
                env as Cloudflare.Env
              );
            }
          } finally {
            // no per-message env namespace mutation
          }

          message.ack();
        } else if (queueName.startsWith("chunk-processing-queue")) {
          const chunk = queueMessage as unknown as Chunk;
          await processChunkJob(chunk, env as Cloudflare.Env);
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
        } else if (
          queueName.startsWith("discord-gateway-events-queue") &&
          !queueName.includes("-dlq")
        ) {
          const gatewayMessage = queueMessage as unknown as DiscordQueueMessage;
          if (gatewayMessage.type === "gateway_event") {
            try {
              // Extract the event type and data from the gateway message
              // The webhook handler expects { t, d } format
              const eventType = (gatewayMessage as any).t;
              const eventData = (gatewayMessage as any).d;

              const result = await handleWebhookEvent({
                t: eventType,
                d: eventData,
              });

              if (!result.success) {
                console.error(
                  formatLog("[queue] Failed to process gateway event:", {
                    queueName,
                    eventType: eventType,
                    error: result.error,
                  })
                );
                // Retry on failure
                message.retry();
              } else {
                console.log(
                  `[queue] Successfully processed gateway event: ${eventType}`
                );
                message.ack();
              }
            } catch (error) {
              const errorMsg =
                error instanceof Error ? error.message : String(error);
              const eventType = (gatewayMessage as any).t;
              console.error(
                formatLog("[queue] Error processing gateway event:", {
                  queueName,
                  eventType: eventType,
                  error: errorMsg,
                })
              );
              message.retry();
            }
          } else {
            console.error(
              formatLog("[queue] Invalid Discord gateway event message type:", {
                queueName,
                message: gatewayMessage,
              })
            );
            message.ack();
          }
        } else if (
          queueName.includes("discord-gateway-events-queue") &&
          queueName.includes("-dlq")
        ) {
          const gatewayMessage = queueMessage as unknown as DiscordQueueMessage;
          const eventType = (gatewayMessage as any).t;
          console.error(
            formatLog("[queue] Gateway event in DLQ:", {
              queueName,
              eventType: eventType,
              message: gatewayMessage,
            })
          );
          // For now, just log DLQ events - could add specific handling later
          message.ack();
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
