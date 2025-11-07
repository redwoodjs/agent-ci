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
import { HomePage } from "./app/pages/HomePage";
import { passkeyRoutes } from "./app/pages/auth/passkey/routes.mjs";

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
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { CursorEventsDurableObject } from "@/app/ingestors/cursor/db/durableObject";
export { GitHubRepoDurableObject } from "@/app/ingestors/github/db/durableObject";
export { GitHubBackfillStateDO } from "@/app/ingestors/github/db/backfill-durableObject";

import { processSchedulerJob } from "@/app/ingestors/github/services/scheduler-service";
import { processProcessorJob } from "@/app/ingestors/github/services/processor-service";
import { handleDeadLetterMessage } from "@/app/ingestors/github/services/dlq-handler";
import type { QueueMessage, ProcessorJobMessage } from "@/app/ingestors/github/services/backfill-types";

export default {
  fetch: app.fetch,
  async queue(batch, env) {
    const queueName = batch.queue;
    
    for (const message of batch.messages) {
      try {
        const queueMessage = message.body as QueueMessage;

        if (
          (queueName === "github-scheduler-queue" || queueName === "SCHEDULER_QUEUE") &&
          queueMessage.type === "scheduler"
        ) {
          await processSchedulerJob(queueMessage);
          message.ack();
        } else if (
          (queueName === "github-processor-queue" || queueName === "PROCESSOR_QUEUE") &&
          queueMessage.type === "processor"
        ) {
          await processProcessorJob(queueMessage);
          message.ack();
        } else if (
          (queueName === "github-processor-queue-dlq" || queueName === "PROCESSOR_QUEUE_DLQ") &&
          queueMessage.type === "processor"
        ) {
          await handleDeadLetterMessage(queueMessage);
          message.ack();
        } else {
          console.error(`[queue] Unknown queue or message type: ${queueName}`, queueMessage);
          message.ack();
        }
      } catch (error) {
        console.error(`[queue] Error processing message from ${queueName}:`, error);
        message.retry();
      }
    }
  },
} as ExportedHandler;
