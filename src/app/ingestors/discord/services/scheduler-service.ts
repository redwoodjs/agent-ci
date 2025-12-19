import { env } from "cloudflare:workers";
import {
  getBackfillState,
  incrementBackfillEnqueuedCount,
  markBackfillEnqueueCompleted,
  updateBackfillState,
} from "./backfill-state";
import type {
  SchedulerJobMessage,
  ProcessorJobMessage,
} from "./backfill-types";
import { fetchDiscordEntity } from "../utils/discord-api";
import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];
type DiscordThread = components["schemas"]["ThreadResponse"];

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_SCHEDULER_QUEUE: Queue<SchedulerJobMessage>;
    DISCORD_PROCESSOR_QUEUE: Queue<ProcessorJobMessage>;
  }
}

function extractThreadInfo(messages: DiscordMessage[]): Set<string> {
  const threadIDs = new Set<string>();

  for (const message of messages) {
    if (message.thread?.id) {
      threadIDs.add(message.thread.id);
    }
  }

  return threadIDs;
}

async function fetchDiscordMessagesPage(
  channelID: string,
  cursor?: string
): Promise<{ data: DiscordMessage[]; nextPage?: string }> {
  const params = new URLSearchParams({ limit: "100" });
  if (cursor) params.set("before", cursor);

  const url = `https://discord.com/api/v10/channels/${channelID}/messages?${params}`;

  const data = await fetchDiscordEntity<DiscordMessage[]>(url);

  const nextPage = data.length === 100 ? data[data.length - 1].id : undefined;

  return { data, nextPage };
}

async function fetchActiveThreads(channelID: string): Promise<DiscordThread[]> {
  const url = `https://discord.com/api/v10/channels/${channelID}/threads/active`;

  try {
    const response = await fetchDiscordEntity<{ threads: DiscordThread[] }>(
      url
    );
    return response.threads || [];
  } catch (error) {
    console.warn(
      `[scheduler] Failed to fetch active threads for channel ${channelID}:`,
      error
    );
    return [];
  }
}

export async function processSchedulerJob(
  message: SchedulerJobMessage
): Promise<void> {
  const {
    guild_channel_key,
    guildID,
    channelID,
    entity_type,
    cursor,
    backfill_run_id,
  } = message;

  console.log(
    `[scheduler] Processing scheduler job: ${guild_channel_key}, entity_type: ${entity_type}, cursor: ${
      cursor || "none"
    }`
  );

  const state = await getBackfillState(guild_channel_key);
  console.log(`[scheduler] Current backfill state:`, state);
  const runId = backfill_run_id ?? state?.current_run_id ?? null;

  if (state?.status === "paused_on_error" || state?.status === "paused") {
    console.log(
      `[scheduler] Backfill paused for ${guild_channel_key} (status: ${state.status}), skipping`
    );
    return;
  }

  await updateBackfillState(guild_channel_key, { status: "in_progress" });

  try {
    const processorQueue = (env as any)
      .DISCORD_PROCESSOR_QUEUE as Queue<ProcessorJobMessage>;

    if (entity_type === "messages") {
      const { data, nextPage } = await fetchDiscordMessagesPage(
        channelID,
        cursor
      );

      console.log(
        `[scheduler] Fetched ${
          data.length
        } messages, hasNextPage: ${!!nextPage}`
      );

      if (data.length > 0) {
        await processorQueue.send({
          type: "processor",
          guild_channel_key,
          guildID,
          channelID,
          entity_type: "channel",
          event_type: "backfill",
          moment_graph_namespace_prefix:
            state?.moment_graph_namespace_prefix ?? null,
          ...(runId ? { backfill_run_id: runId } : {}),
        });

        const threadIDs = extractThreadInfo(data);
        console.log(`[scheduler] Found ${threadIDs.size} threads in messages`);

        for (const threadID of threadIDs) {
          await processorQueue.send({
            type: "processor",
            guild_channel_key,
            guildID,
            channelID,
            entity_type: "thread",
            entity_id: threadID,
            event_type: "backfill",
            moment_graph_namespace_prefix:
              state?.moment_graph_namespace_prefix ?? null,
            ...(runId ? { backfill_run_id: runId } : {}),
          });
        }

        if (runId) {
          await incrementBackfillEnqueuedCount(
            guild_channel_key,
            runId,
            1 + threadIDs.size
          );
        }
      }

      if (nextPage) {
        await updateBackfillState(guild_channel_key, {
          messages_cursor: nextPage,
        });

        await (env as any).DISCORD_SCHEDULER_QUEUE.send({
          ...message,
          cursor: nextPage,
          ...(runId ? { backfill_run_id: runId } : {}),
        });
      } else {
        await updateBackfillState(guild_channel_key, {
          messages_cursor: null,
        });

        await (env as any).DISCORD_SCHEDULER_QUEUE.send({
          type: "scheduler",
          guild_channel_key,
          guildID,
          channelID,
          entity_type: "threads",
          ...(runId ? { backfill_run_id: runId } : {}),
        });
      }
    } else if (entity_type === "threads") {
      const activeThreads = await fetchActiveThreads(channelID);

      console.log(`[scheduler] Found ${activeThreads.length} active threads`);

      for (const thread of activeThreads) {
        await processorQueue.send({
          type: "processor",
          guild_channel_key,
          guildID,
          channelID,
          entity_type: "thread",
          entity_id: thread.id,
          event_type: "backfill",
          moment_graph_namespace_prefix:
            state?.moment_graph_namespace_prefix ?? null,
          ...(runId ? { backfill_run_id: runId } : {}),
        });
      }

      if (runId) {
        await incrementBackfillEnqueuedCount(
          guild_channel_key,
          runId,
          activeThreads.length
        );
      }

      await updateBackfillState(guild_channel_key, {
        threads_cursor: null,
        status: "completed",
      });

      if (runId) {
        await markBackfillEnqueueCompleted(guild_channel_key, runId);
        const updated = await getBackfillState(guild_channel_key);
        console.log("[backfill] enqueue completed", {
          guildChannelKey: guild_channel_key,
          backfillRunId: runId,
          momentGraphNamespacePrefix:
            updated?.moment_graph_namespace_prefix ?? null,
          enqueuedCount: updated?.enqueued_count ?? 0,
        });
      } else {
        console.log(`[scheduler] Backfill completed for ${guild_channel_key}`);
      }
    }
  } catch (error) {
    console.error(`[scheduler] Error processing scheduler job:`, error);
    await updateBackfillState(guild_channel_key, {
      status: "paused_on_error",
      error_message: error instanceof Error ? error.message : "Unknown error",
      error_details: error instanceof Error ? error.stack || "" : "",
    });
    throw error;
  }
}
