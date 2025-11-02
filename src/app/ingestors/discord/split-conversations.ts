"use server";

import { db } from "@/db";
import { rawDiscordDb } from "./db";
import { env } from "cloudflare:workers";

interface RawDiscordMessage {
  message_id: string;
  channel_id: string;
  guild_id: string;
  author_id: string;
  content: string;
  timestamp: string;
  thread_id: string | null;
  reply_to_message_id: string | null;
  reply_to_channel_id: string | null;
  raw_data: string;
  ingested_at: string;
  processed_state: string;
}

interface ConversationSplit {
  startTime: string;
  endTime: string;
  messages: RawDiscordMessage[];
  participantIDs: Set<string>;
  threadIDs: Set<string>;
  splitType: "temporal" | "thread" | "combined";
}

function splitByTemporalGaps(
  messages: RawDiscordMessage[],
  gapThresholdMs: number = 4 * 60 * 60 * 1000
): ConversationSplit[] {
  if (messages.length === 0) return [];

  const splits: ConversationSplit[] = [];
  let currentSplit: RawDiscordMessage[] = [messages[0]];
  let lastTimestamp = new Date(messages[0].timestamp).getTime();

  for (let i = 1; i < messages.length; i++) {
    const currentTimestamp = new Date(messages[i].timestamp).getTime();
    const gap = currentTimestamp - lastTimestamp;

    if (gap > gapThresholdMs) {
      splits.push(createSplitFromMessages(currentSplit, "temporal"));
      currentSplit = [messages[i]];
    } else {
      currentSplit.push(messages[i]);
    }

    lastTimestamp = currentTimestamp;
  }

  if (currentSplit.length > 0) {
    splits.push(createSplitFromMessages(currentSplit, "temporal"));
  }

  return splits;
}

function createSplitFromMessages(
  messages: RawDiscordMessage[],
  splitType: ConversationSplit["splitType"]
): ConversationSplit {
  const participantIDs = new Set<string>();
  const threadIDs = new Set<string>();

  for (const msg of messages) {
    participantIDs.add(msg.author_id);
    if (msg.thread_id) {
      threadIDs.add(msg.thread_id);
    }
  }

  return {
    startTime: messages[0].timestamp,
    endTime: messages[messages.length - 1].timestamp,
    messages,
    participantIDs,
    threadIDs,
    splitType,
  };
}

function preserveThreads(splits: ConversationSplit[]): ConversationSplit[] {
  const messagesByID = new Map<string, RawDiscordMessage>();
  const allMessages: RawDiscordMessage[] = [];

  for (const split of splits) {
    for (const msg of split.messages) {
      messagesByID.set(msg.message_id, msg);
      allMessages.push(msg);
    }
  }

  const threadGroups = new Map<string, RawDiscordMessage[]>();

  for (const msg of allMessages) {
    const rootID = msg.reply_to_message_id 
      ? findThreadRoot(msg, messagesByID)
      : msg.message_id;
    
    if (!threadGroups.has(rootID)) {
      threadGroups.set(rootID, []);
    }
    threadGroups.get(rootID)!.push(msg);
  }

  const newSplits: ConversationSplit[] = [];

  for (const split of splits) {
    const messagesInSplit = new Set(split.messages.map(m => m.message_id));
    const threadRootsInSplit = new Set<string>();

    for (const msg of split.messages) {
      const rootID = msg.reply_to_message_id
        ? findThreadRoot(msg, messagesByID)
        : msg.message_id;
      threadRootsInSplit.add(rootID);
    }

    const expandedMessages: RawDiscordMessage[] = [];
    const seenIDs = new Set<string>();

    for (const rootID of threadRootsInSplit) {
      const threadMessages = threadGroups.get(rootID) || [];
      for (const msg of threadMessages) {
        if (!seenIDs.has(msg.message_id)) {
          expandedMessages.push(msg);
          seenIDs.add(msg.message_id);
        }
      }
    }

    expandedMessages.sort((a, b) => 
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    if (expandedMessages.length > 0) {
      newSplits.push(createSplitFromMessages(expandedMessages, "combined"));
    }
  }

  return newSplits;
}

function findThreadRoot(
  message: RawDiscordMessage,
  messagesByID: Map<string, RawDiscordMessage>
): string {
  if (!message.reply_to_message_id) {
    return message.message_id;
  }
  const parent = messagesByID.get(message.reply_to_message_id);
  if (!parent) {
    return message.message_id;
  }
  return findThreadRoot(parent, messagesByID);
}

function generateConversationMarkdown(split: ConversationSplit): string {
  const messagesByID = new Map<string, RawDiscordMessage>();
  for (const msg of split.messages) {
    messagesByID.set(msg.message_id, msg);
  }

  const rootMessages = split.messages.filter((msg) => !msg.reply_to_message_id);
  const lines: string[] = [];

  function formatMessage(
    msg: RawDiscordMessage,
    indentLevel: number = 0
  ): void {
    const indent = "> ".repeat(indentLevel);
    const date = new Date(msg.timestamp).toISOString();

    let authorName = "unknown";
    try {
      const rawData = JSON.parse(msg.raw_data);
      authorName =
        rawData.author?.username || rawData.author?.global_name || "unknown";
    } catch {
      authorName = "unknown";
    }

    lines.push(`${indent}[${date}] ${authorName}: ${msg.content}`);

    const replies = split.messages.filter(
      (m) => m.reply_to_message_id === msg.message_id
    );
    for (const reply of replies) {
      formatMessage(reply, indentLevel + 1);
    }
  }

  for (const rootMsg of rootMessages) {
    formatMessage(rootMsg);
  }

  return lines.join("\n");
}

async function storeSplitToR2(
  split: ConversationSplit,
  artifactID: number,
  splitIndex: number,
  channelID: string,
  guildID: string
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bucketPath = `discord/${guildID}/${channelID}/${timestamp}/split-${splitIndex}/`;

  const markdown = generateConversationMarkdown(split);
  const markdownKey = `${bucketPath}conversation.md`;
  await env.MACHINEN_BUCKET.put(markdownKey, markdown);

  const metadata = {
    artifactID,
    splitIndex,
    splitType: split.splitType,
    startTime: split.startTime,
    endTime: split.endTime,
    messageCount: split.messages.length,
    participantCount: split.participantIDs.size,
    threadCount: split.threadIDs.size,
    participantIDs: Array.from(split.participantIDs),
    threadIDs: Array.from(split.threadIDs),
  };

  const metadataKey = `${bucketPath}metadata.json`;
  await env.MACHINEN_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2));

  return bucketPath;
}

export async function splitDiscordMessages(
  artifactID: number
): Promise<{ splitsCreated: number; error?: string }> {
  try {
    const artifact = await db
      .selectFrom("artifacts")
      .selectAll()
      .where("id", "=", artifactID)
      .executeTakeFirstOrThrow();

    const source = await db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", artifact.sourceID)
      .executeTakeFirstOrThrow();

    if (source.type !== "discord") {
      return {
        splitsCreated: 0,
        error: "Artifact is not from a Discord source",
      };
    }

    const sourceDescription = JSON.parse(source.description || "{}");
    const channelID = sourceDescription.channelID;
    const guildID = sourceDescription.guildID;

    if (!channelID || !guildID) {
      return {
        splitsCreated: 0,
        error: "Missing channelID or guildID in source description",
      };
    }

    const messages = await rawDiscordDb
      .selectFrom("raw_discord_messages")
      .selectAll()
      .where("channel_id", "=", channelID)
      .where("guild_id", "=", guildID)
      .where("processed_state", "=", "processed")
      .orderBy("timestamp", "asc")
      .execute();

    if (messages.length === 0) {
      return { splitsCreated: 0, error: "No processed messages found" };
    }

    const temporalSplits = splitByTemporalGaps(messages);
    const threadAwareSplits = preserveThreads(temporalSplits);

    let splitIndex = 0;
    for (const split of threadAwareSplits) {
      const bucketPath = await storeSplitToR2(
        split,
        artifactID,
        splitIndex,
        channelID,
        guildID
      );

      await db
        .insertInto("conversation_splits")
        .values({
          // @ts-ignore
          id: null,
          artifactID,
          splitType: split.splitType,
          startTime: split.startTime,
          endTime: split.endTime,
          messageCount: split.messages.length,
          participantCount: split.participantIDs.size,
          threadCount: split.threadIDs.size,
          topics: null,
          metadata: JSON.stringify({ bucketPath }),
          createdAt: new Date().toISOString(),
        })
        .execute();

      splitIndex++;
    }

    return { splitsCreated: threadAwareSplits.length };
  } catch (error) {
    console.error("Error splitting Discord messages:", error);
    return {
      splitsCreated: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function splitAllUnprocessedArtifacts(): Promise<{
  processed: number;
  errors: string[];
}> {
  const artifacts = await db
    .selectFrom("artifacts")
    .innerJoin("sources", "sources.id", "artifacts.sourceID")
    .select(["artifacts.id", "sources.type"])
    .where("sources.type", "=", "discord")
    .execute();

  const discordArtifacts = artifacts.filter(
    (artifact) => artifact.type === "discord"
  );

  const processedArtifactIDs = new Set(
    (
      await db
        .selectFrom("conversation_splits")
        .select("artifactID")
        .distinct()
        .execute()
    ).map((row) => row.artifactID)
  );

  const unprocessedArtifacts = discordArtifacts.filter(
    (artifact) => !processedArtifactIDs.has(artifact.id)
  );

  const errors: string[] = [];
  let processed = 0;

  for (const artifact of unprocessedArtifacts) {
    const result = await splitDiscordMessages(artifact.id);
    if (result.error) {
      errors.push(`Artifact ${artifact.id}: ${result.error}`);
    } else {
      processed++;
    }
  }

  return { processed, errors };
}
