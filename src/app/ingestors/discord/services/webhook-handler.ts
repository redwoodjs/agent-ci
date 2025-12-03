import { z } from "zod";
import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";
import { processThreadEvent } from "./thread-processor";
import { DiscordWebhookBatcherDO } from "../db/webhook-batcher-durableObject";

type DiscordMessage = components["schemas"]["MessageResponse"];

// Discord Gateway Event schemas
const messageCreateSchema = z.object({
  t: z.literal("MESSAGE_CREATE"),
  d: z.object({
    id: z.string(),
    channel_id: z.string(),
    guild_id: z.string().optional(),
    content: z.string(),
    timestamp: z.string(),
    author: z.object({
      id: z.string(),
      username: z.string(),
      global_name: z.string().optional(),
    }),
    thread: z
      .object({
        id: z.string(),
        name: z.string(),
      })
      .optional(),
  }),
});

const messageUpdateSchema = z.object({
  t: z.literal("MESSAGE_UPDATE"),
  d: z.object({
    id: z.string(),
    channel_id: z.string(),
    guild_id: z.string().optional(),
    content: z.string().optional(),
    timestamp: z.string(),
    edited_timestamp: z.string().optional(),
    author: z
      .object({
        id: z.string(),
        username: z.string(),
        global_name: z.string().optional(),
      })
      .optional(),
  }),
});

const messageDeleteSchema = z.object({
  t: z.literal("MESSAGE_DELETE"),
  d: z.object({
    id: z.string(),
    channel_id: z.string(),
    guild_id: z.string().optional(),
  }),
});

const threadCreateSchema = z.object({
  t: z.literal("THREAD_CREATE"),
  d: z.object({
    id: z.string(),
    guild_id: z.string(),
    parent_id: z.string(),
    name: z.string(),
  }),
});

const threadUpdateSchema = z.object({
  t: z.literal("THREAD_UPDATE"),
  d: z.object({
    id: z.string(),
    guild_id: z.string(),
    parent_id: z.string(),
    name: z.string().optional(),
  }),
});

const threadDeleteSchema = z.object({
  t: z.literal("THREAD_DELETE"),
  d: z.object({
    id: z.string(),
    guild_id: z.string(),
    parent_id: z.string(),
  }),
});

const threadListSyncSchema = z.object({
  t: z.literal("THREAD_LIST_SYNC"),
  d: z.object({
    guild_id: z.string(),
    channel_ids: z.array(z.string()).optional(),
    threads: z.array(z.any()),
    members: z.array(z.any()),
  }),
});

const threadMemberUpdateSchema = z.object({
  t: z.literal("THREAD_MEMBER_UPDATE"),
  d: z.object({
    id: z.string(),
    user_id: z.string(),
    guild_id: z.string(),
    join_timestamp: z.string().optional(),
    flags: z.number().optional(),
  }),
});

const threadMembersUpdateSchema = z.object({
  t: z.literal("THREAD_MEMBERS_UPDATE"),
  d: z.object({
    id: z.string(),
    guild_id: z.string(),
    member_count: z.number(),
    added_members: z.array(z.any()).optional(),
    removed_member_ids: z.array(z.string()).optional(),
  }),
});

const discordWebhookEventSchema = z.discriminatedUnion("t", [
  messageCreateSchema,
  messageUpdateSchema,
  messageDeleteSchema,
  threadCreateSchema,
  threadUpdateSchema,
  threadDeleteSchema,
  threadListSyncSchema,
  threadMemberUpdateSchema,
  threadMembersUpdateSchema,
]);

// Lightweight schema to detect basic Discord Gateway / webhook envelopes
const baseDiscordEventSchema = z.object({
  t: z.string().nullable(),
  d: z.any(),
});

const SUPPORTED_EVENT_TYPES = new Set([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "THREAD_CREATE",
  "THREAD_UPDATE",
  "THREAD_DELETE",
  "THREAD_LIST_SYNC",
  "THREAD_MEMBER_UPDATE",
  "THREAD_MEMBERS_UPDATE",
]);

type DiscordWebhookEvent = z.infer<typeof discordWebhookEventSchema>;

function getDailyR2Key(
  guildID: string,
  channelID: string,
  date: string
): string {
  return `discord/${guildID}/${channelID}/${date}.jsonl`;
}

function getFileKey(guildID: string, channelID: string, date: string): string {
  return `${guildID}/${channelID}/${date}`;
}

async function getBatcherDO(fileKey: string): Promise<DurableObjectStub> {
  const namespace = (env as any)
    .DISCORD_WEBHOOK_BATCHER as DurableObjectNamespace;
  const id = namespace.idFromName(fileKey);
  return namespace.get(id);
}

export async function handleMessageCreate(event: {
  t: "MESSAGE_CREATE";
  d: any;
}): Promise<void> {
  const { d: message } = event;

  // Skip thread messages - they're handled by thread events
  if (message.thread) {
    return;
  }

  if (!message.guild_id) {
    console.warn("[webhook-handler] MESSAGE_CREATE missing guild_id, skipping");
    return;
  }

  const date = message.timestamp.split("T")[0];
  const fileKey = getFileKey(message.guild_id, message.channel_id, date);

  // Get batcher DO instance
  const batcher = await getBatcherDO(fileKey);
  await batcher.fetch("http://internal/add-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, fileKey }),
  });

  console.log(
    `[webhook-handler] Queued MESSAGE_CREATE for message ${message.id} in channel ${message.channel_id}`
  );
}

export async function handleMessageUpdate(event: {
  t: "MESSAGE_UPDATE";
  d: any;
}): Promise<void> {
  const { d: message } = event;

  if (!message.guild_id) {
    console.warn("[webhook-handler] MESSAGE_UPDATE missing guild_id, skipping");
    return;
  }

  const date = message.timestamp.split("T")[0];
  const fileKey = getFileKey(message.guild_id, message.channel_id, date);
  const r2Key = getDailyR2Key(message.guild_id, message.channel_id, date);

  // Flush any pending messages in batcher first
  const batcher = await getBatcherDO(fileKey);
  await batcher.fetch("http://internal/flush", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  // Read existing file
  let existingMessages: DiscordMessage[] = [];
  const existing = await env.MACHINEN_BUCKET.get(r2Key);
  if (existing) {
    const text = await existing.text();
    const lines = text
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    existingMessages = lines.map((line) => JSON.parse(line));
  }

  // Find and update the message
  const messageIndex = existingMessages.findIndex((m) => m.id === message.id);
  if (messageIndex === -1) {
    console.warn(
      `[webhook-handler] MESSAGE_UPDATE: message ${message.id} not found in ${r2Key}, skipping`
    );
    return;
  }

  // Update the message (merge with existing to preserve fields not in update)
  existingMessages[messageIndex] = {
    ...existingMessages[messageIndex],
    ...message,
    edited_timestamp: message.edited_timestamp || message.timestamp,
  };

  // Write back to R2
  const jsonl = existingMessages.map((m) => JSON.stringify(m)).join("\n");
  await env.MACHINEN_BUCKET.put(r2Key, jsonl);

  console.log(`[webhook-handler] Updated message ${message.id} in ${r2Key}`);
}

export async function handleMessageDelete(event: {
  t: "MESSAGE_DELETE";
  d: any;
}): Promise<void> {
  const { d: message } = event;

  if (!message.guild_id) {
    console.warn("[webhook-handler] MESSAGE_DELETE missing guild_id, skipping");
    return;
  }

  // We need the timestamp to determine which file, but DELETE events don't include it
  // We'll need to read all files for this channel or use a different approach
  // For now, we'll try to find it in today's file (most common case)
  const today = new Date().toISOString().split("T")[0];
  const fileKey = getFileKey(message.guild_id, message.channel_id, today);
  const r2Key = getDailyR2Key(message.guild_id, message.channel_id, today);

  // Flush any pending messages in batcher first
  const batcher = await getBatcherDO(fileKey);
  await batcher.fetch("http://internal/flush", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  // Read existing file
  let existingMessages: DiscordMessage[] = [];
  const existing = await env.MACHINEN_BUCKET.get(r2Key);
  if (existing) {
    const text = await existing.text();
    const lines = text
      .trim()
      .split("\n")
      .filter((line) => line.trim());
    existingMessages = lines.map((line) => JSON.parse(line));
  }

  // Filter out the deleted message
  const filteredMessages = existingMessages.filter((m) => m.id !== message.id);

  if (filteredMessages.length === existingMessages.length) {
    console.warn(
      `[webhook-handler] MESSAGE_DELETE: message ${message.id} not found in ${r2Key}, skipping`
    );
    return;
  }

  // Write back to R2
  const jsonl = filteredMessages.map((m) => JSON.stringify(m)).join("\n");
  await env.MACHINEN_BUCKET.put(r2Key, jsonl);

  console.log(`[webhook-handler] Deleted message ${message.id} from ${r2Key}`);
}

export async function handleThreadEvent(event: {
  t: "THREAD_CREATE" | "THREAD_UPDATE" | "THREAD_DELETE";
  d: any;
}): Promise<void> {
  const { d: thread } = event;

  if (!thread.guild_id || !thread.parent_id) {
    console.warn(
      `[webhook-handler] ${event.t} missing guild_id or parent_id, skipping`
    );
    return;
  }

  if (event.t === "THREAD_DELETE") {
    // For thread deletion, we could mark the thread as deleted in R2
    // For now, we'll just log it - the thread processor will handle it on next sync
    console.log(
      `[webhook-handler] THREAD_DELETE for thread ${thread.id} in channel ${thread.parent_id}`
    );
    return;
  }

  // Process thread using existing thread processor
  // This will fetch the complete thread state and update latest.json
  await processThreadEvent(thread.guild_id, thread.parent_id, thread.id);

  console.log(
    `[webhook-handler] Processed ${event.t} for thread ${thread.id} in channel ${thread.parent_id}`
  );
}

export async function handleThreadListSync(event: {
  t: "THREAD_LIST_SYNC";
  d: any;
}): Promise<void> {
  const { d: data } = event;

  if (!data.guild_id) {
    console.warn(
      "[webhook-handler] THREAD_LIST_SYNC missing guild_id, skipping"
    );
    return;
  }

  // Process all threads in the sync
  if (data.threads && Array.isArray(data.threads)) {
    for (const thread of data.threads) {
      if (thread.id && thread.parent_id) {
        await processThreadEvent(data.guild_id, thread.parent_id, thread.id);
      }
    }
  }

  console.log(
    `[webhook-handler] Processed THREAD_LIST_SYNC for guild ${data.guild_id}, ${
      data.threads?.length || 0
    } threads`
  );
}

export async function handleThreadMemberUpdate(event: {
  t: "THREAD_MEMBER_UPDATE";
  d: any;
}): Promise<void> {
  const { d: data } = event;

  if (!data.guild_id || !data.id) {
    console.warn(
      "[webhook-handler] THREAD_MEMBER_UPDATE missing guild_id or thread id, skipping"
    );
    return;
  }

  // Thread member updates don't require full thread reprocessing
  // We'll just log it for now
  console.log(
    `[webhook-handler] THREAD_MEMBER_UPDATE for thread ${data.id} in guild ${data.guild_id}`
  );
}

export async function handleThreadMembersUpdate(event: {
  t: "THREAD_MEMBERS_UPDATE";
  d: any;
}): Promise<void> {
  const { d: data } = event;

  if (!data.guild_id || !data.id) {
    console.warn(
      "[webhook-handler] THREAD_MEMBERS_UPDATE missing guild_id or thread id, skipping"
    );
    return;
  }

  // Thread members updates don't require full thread reprocessing
  // We'll just log it for now
  console.log(
    `[webhook-handler] THREAD_MEMBERS_UPDATE for thread ${data.id} in guild ${data.guild_id}, member_count: ${data.member_count}`
  );
}

export async function handleWebhookEvent(
  payload: unknown
): Promise<{ success: boolean; error?: string }> {
  try {
    // First, make sure this looks like a Discord event and inspect the type
    const base = baseDiscordEventSchema.safeParse(payload);

    if (!base.success) {
      console.warn(
        "[webhook-handler] Received payload without valid Discord envelope, ignoring"
      );
      return { success: false, error: "Invalid Discord event envelope" };
    }

    const { t, d } = base.data;

    if (!t) {
      console.warn(
        "[webhook-handler] Received Discord event without type 't', ignoring"
      );
      return { success: false, error: "Missing event type 't'" };
    }

    if (!SUPPORTED_EVENT_TYPES.has(t)) {
      // This is expected for many Gateway events (e.g. GUILD_CREATE, PRESENCE_UPDATE, etc.)
      console.log(
        `[webhook-handler] Ignoring unsupported Discord event type: ${t}`
      );
      return { success: true };
    }

    // Now that we know it's a supported type, run full validation
    const event = discordWebhookEventSchema.parse({ t, d });

    switch (event.t) {
      case "MESSAGE_CREATE":
        await handleMessageCreate(event);
        break;
      case "MESSAGE_UPDATE":
        await handleMessageUpdate(event);
        break;
      case "MESSAGE_DELETE":
        await handleMessageDelete(event);
        break;
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
      case "THREAD_DELETE":
        await handleThreadEvent(event);
        break;
      case "THREAD_LIST_SYNC":
        await handleThreadListSync(event);
        break;
      case "THREAD_MEMBER_UPDATE":
        await handleThreadMemberUpdate(event);
        break;
      case "THREAD_MEMBERS_UPDATE":
        await handleThreadMembersUpdate(event);
        break;
      default:
        console.warn(
          `[webhook-handler] Unhandled event type: ${(event as any).t}`
        );
        return {
          success: false,
          error: `Unhandled event type: ${(event as any).t}`,
        };
    }

    return { success: true };
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error("[webhook-handler] Validation error:", error.issues);
      return {
        success: false,
        error: `Validation failed: ${error.issues
          .map((i) => i.message)
          .join(", ")}`,
      };
    }
    console.error("[webhook-handler] Error processing event:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
