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

interface DailyStreamEntry {
  timestamp: string;
  type: "orphaned" | "thread_ref" | "reply_chain_ref";
  content?: string;
  author?: string;
  splitType?: "thread" | "reply_chain";
  messageCount?: number;
  participantCount?: number;
  startTime?: string;
  endTime?: string;
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

function createDailyStreams(
  allMessages: RawDiscordMessage[],
  splits: ConversationSplit[]
): Map<string, DailyStreamEntry[]> {
  const messagesByDate = new Map<string, DailyStreamEntry[]>();

  const messageToSplit = new Map<string, ConversationSplit>();
  for (const split of splits) {
    if (split.splitType === "orphaned") {
      continue;
    }
    for (const msg of split.messages) {
      messageToSplit.set(msg.message_id, split);
    }
  }

  const sorted = [...allMessages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  const processedSplits = new Set<ConversationSplit>();

  for (const msg of sorted) {
    const date = msg.timestamp.split("T")[0];

    if (!messagesByDate.has(date)) {
      messagesByDate.set(date, []);
    }

    const split = messageToSplit.get(msg.message_id);

    if (split && !processedSplits.has(split)) {
      processedSplits.add(split);

      messagesByDate.get(date)!.push({
        timestamp: msg.timestamp,
        type: split.splitType === "thread" ? "thread_ref" : "reply_chain_ref",
        splitType: split.splitType as "thread" | "reply_chain",
        messageCount: split.messages.length,
        participantCount: split.participantIDs.size,
        startTime: split.startTime,
        endTime: split.endTime,
      });
    } else if (!split) {
      let authorName = "unknown";
      try {
        const rawData = JSON.parse(msg.raw_data);
        authorName =
          rawData.author?.global_name || rawData.author?.username || "unknown";
      } catch {}

      messagesByDate.get(date)!.push({
        timestamp: msg.timestamp,
        type: "orphaned",
        content: msg.content,
        author: authorName,
      });
    }
  }

  return messagesByDate;
}

function generateDailyStreamMarkdown(
  entries: DailyStreamEntry[],
  date: string
): string {
  const lines = [`# ${date}`, ""];

  for (const entry of entries) {
    const time = entry.timestamp.split("T")[1].substring(0, 8);

    if (entry.type === "orphaned") {
      lines.push(`[${time}] ${entry.author}: ${entry.content}`, "");
    } else if (entry.type === "thread_ref") {
      const duration = `${entry.startTime
        ?.split("T")[1]
        .substring(0, 8)} - ${entry.endTime?.split("T")[1].substring(0, 8)}`;
      lines.push(
        `[${time}] → Thread`,
        `         Messages: ${entry.messageCount} | Participants: ${entry.participantCount}`,
        `         Duration: ${duration}`,
        ""
      );
    } else if (entry.type === "reply_chain_ref") {
      const duration = `${entry.startTime
        ?.split("T")[1]
        .substring(0, 8)} - ${entry.endTime?.split("T")[1].substring(0, 8)}`;
      lines.push(
        `[${time}] → Reply Chain`,
        `         Messages: ${entry.messageCount} | Participants: ${entry.participantCount}`,
        `         Duration: ${duration}`,
        ""
      );
    }
  }

  return lines.join("\n");
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

  const messagesByChannelAndGuild = new Map<string, RawDiscordMessage[]>();

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

      for (const split of splits) {
        result.splitsByType[split.splitType]++;
      }

      const dailyStreams = createDailyStreams(messages, splits);
      for (const [date, entries] of dailyStreams) {
        const markdown = generateDailyStreamMarkdown(entries, date);
        const dailyPath = `discord/${guildID}/${channelID}/daily/${date}.md`;
        await env.MACHINEN_BUCKET.put(dailyPath, markdown);
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
        `Processed channel ${channelID}: created ${dailyStreams.size} daily streams with ${result.splitsByType.thread} threads, ${result.splitsByType.reply_chain} reply chains, ${result.splitsByType.orphaned} orphaned messages`
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
