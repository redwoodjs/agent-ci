"use server";

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
  splitType: "thread" | "reply_chain" | "orphaned";
  messages: RawDiscordMessage[];
  threadID: string | null;
  startTime: string;
  endTime: string;
  participantIDs: Set<string>;
}

interface ProcessingResult {
  processedCount: number;
  splitsCreated: number;
  splitsByType: {
    thread: number;
    reply_chain: number;
    orphaned: number;
  };
}

function groupMessagesByThread(
  messages: RawDiscordMessage[]
): Map<string, RawDiscordMessage[]> {
  const threadGroups = new Map<string, RawDiscordMessage[]>();

  for (const message of messages) {
    if (message.thread_id) {
      if (!threadGroups.has(message.thread_id)) {
        threadGroups.set(message.thread_id, []);
      }
      threadGroups.get(message.thread_id)!.push(message);
    }
  }

  return threadGroups;
}

function buildReplyChains(
  messages: RawDiscordMessage[]
): Map<string, RawDiscordMessage[]> {
  const messagesByID = new Map<string, RawDiscordMessage>();
  const replyChains = new Map<string, RawDiscordMessage[]>();

  for (const message of messages) {
    messagesByID.set(message.message_id, message);
  }

  function findRootMessage(message: RawDiscordMessage): string {
    if (!message.reply_to_message_id) {
      return message.message_id;
    }
    const parent = messagesByID.get(message.reply_to_message_id);
    if (!parent) {
      return message.message_id;
    }
    return findRootMessage(parent);
  }

  for (const message of messages) {
    const rootID = findRootMessage(message);
    if (!replyChains.has(rootID)) {
      replyChains.set(rootID, []);
    }
    replyChains.get(rootID)!.push(message);
  }

  return replyChains;
}

function createConversationSplits(
  messages: RawDiscordMessage[]
): ConversationSplit[] {
  const splits: ConversationSplit[] = [];
  const processedMessageIDs = new Set<string>();

  const threadGroups = groupMessagesByThread(messages);
  for (const [threadID, threadMessages] of threadGroups) {
    threadMessages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const participantIDs = new Set(threadMessages.map((m) => m.author_id));

    splits.push({
      splitType: "thread",
      messages: threadMessages,
      threadID,
      startTime: threadMessages[0].timestamp,
      endTime: threadMessages[threadMessages.length - 1].timestamp,
      participantIDs,
    });

    for (const msg of threadMessages) {
      processedMessageIDs.add(msg.message_id);
    }
  }

  const remainingMessages = messages.filter(
    (m) => !processedMessageIDs.has(m.message_id)
  );

  const messagesWithReplies = remainingMessages.filter(
    (m) => m.reply_to_message_id !== null
  );
  const orphanedMessages = remainingMessages.filter(
    (m) => m.reply_to_message_id === null
  );

  const replyChains = buildReplyChains(messagesWithReplies);
  for (const [rootID, chainMessages] of replyChains) {
    if (chainMessages.length === 0) continue;

    chainMessages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const participantIDs = new Set(chainMessages.map((m) => m.author_id));

    splits.push({
      splitType: "reply_chain",
      messages: chainMessages,
      threadID: null,
      startTime: chainMessages[0].timestamp,
      endTime: chainMessages[chainMessages.length - 1].timestamp,
      participantIDs,
    });
  }

  for (const orphanedMessage of orphanedMessages) {
    splits.push({
      splitType: "orphaned",
      messages: [orphanedMessage],
      threadID: null,
      startTime: orphanedMessage.timestamp,
      endTime: orphanedMessage.timestamp,
      participantIDs: new Set([orphanedMessage.author_id]),
    });
  }

  return splits;
}

function generateConversationMarkdown(split: ConversationSplit): string {
  const messagesByID = new Map<string, RawDiscordMessage>();
  for (const msg of split.messages) {
    messagesByID.set(msg.message_id, msg);
  }

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
        rawData.author?.global_name ||
        rawData.author?.username ||
        "unknown";
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

  const rootMessages = split.messages.filter(
    (msg) => !msg.reply_to_message_id
  );

  for (const rootMsg of rootMessages) {
    formatMessage(rootMsg);
  }

  return lines.join("\n");
}

async function storeSplitToR2(
  split: ConversationSplit,
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
    splitIndex,
    splitType: split.splitType,
    startTime: split.startTime,
    endTime: split.endTime,
    messageCount: split.messages.length,
    participantCount: split.participantIDs.size,
    threadID: split.threadID,
    participantIDs: Array.from(split.participantIDs),
    channelID,
    guildID,
  };

  const metadataKey = `${bucketPath}metadata.json`;
  await env.MACHINEN_BUCKET.put(
    metadataKey,
    JSON.stringify(metadata, null, 2)
  );

  return bucketPath;
}

async function processUnprocessedMessages(): Promise<ProcessingResult> {
  const unprocessedMessages = await rawDiscordDb
    .selectFrom("raw_discord_messages")
    .selectAll()
    .where("processed_state", "=", "unprocessed")
    .orderBy("timestamp", "asc")
    .execute();

  if (unprocessedMessages.length === 0) {
    console.log("No unprocessed messages found");
    return {
      processedCount: 0,
      splitsCreated: 0,
      splitsByType: { thread: 0, reply_chain: 0, orphaned: 0 },
    };
  }

  console.log(`Found ${unprocessedMessages.length} unprocessed messages`);

  const messagesByChannelAndGuild = new Map<
    string,
    RawDiscordMessage[]
  >();

  for (const message of unprocessedMessages) {
    const key = `${message.guild_id}#${message.channel_id}`;
    if (!messagesByChannelAndGuild.has(key)) {
      messagesByChannelAndGuild.set(key, []);
    }
    messagesByChannelAndGuild.get(key)!.push(message);
  }

  const result: ProcessingResult = {
    processedCount: 0,
    splitsCreated: 0,
    splitsByType: { thread: 0, reply_chain: 0, orphaned: 0 },
  };

  for (const [key, messages] of messagesByChannelAndGuild) {
    const [guildID, channelID] = key.split("#");

    try {
      const splits = createConversationSplits(messages);

      for (let i = 0; i < splits.length; i++) {
        const split = splits[i];
        await storeSplitToR2(split, i, channelID, guildID);

        result.splitsCreated++;
        result.splitsByType[split.splitType]++;
      }

      await rawDiscordDb
        .updateTable("raw_discord_messages")
        .set({ processed_state: "processed" })
        .where("guild_id", "=", guildID)
        .where("channel_id", "=", channelID)
        .where("processed_state", "=", "unprocessed")
        .execute();

      result.processedCount += messages.length;

      console.log(
        `Processed channel ${channelID}: ${splits.length} splits created (${result.splitsByType.thread} threads, ${result.splitsByType.reply_chain} reply chains, ${result.splitsByType.orphaned} orphaned)`
      );
    } catch (error) {
      console.error(`Error processing channel ${channelID}:`, error);
    }
  }

  return result;
}

export async function processDiscordMessages(): Promise<ProcessingResult> {
  try {
    const result = await processUnprocessedMessages();
    console.log("Processing result:", result);
    return result;
  } catch (error) {
    console.error("Error processing Discord messages:", error);
    throw error;
  }
}
