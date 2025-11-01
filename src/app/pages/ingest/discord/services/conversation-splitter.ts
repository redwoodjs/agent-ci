type DiscordMessage = {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    global_name: string | null;
  };
  message_reference?: {
    message_id: string;
    channel_id: string;
  };
  thread?: {
    name: string;
    message_count: number;
    member_count: number;
  };
  reactions?: Array<{
    emoji: { name: string };
    count: number;
  }>;
};

type ConversationSplit = {
  id: string;
  startTime: string;
  endTime: string;
  messageCount: number;
  participantCount: number;
  threadCount: number;
  participants: string[];
  threadIds: string[];
  splitType: "temporal" | "topic" | "thread";
  parentSplitId?: string;
  messages: DiscordMessage[];
};

type ConversationArtifact = {
  id: string;
  sourceId: number;
  kind: "discord_conversation";
  providerId: string;
  title: string;
  content: string;
  contentFormat: "markdown";
  metadata: {
    channelId: string;
    guildId: string;
    splitType: string;
    threadIds: string[];
    participants: string[];
    messageCount: number;
    timeSpan: { start: string; end: string };
  };
};

// Configuration for splitting logic
const SPLIT_CONFIG = {
  // Split at midnight UTC for daily boundaries
  DAILY_BOUNDARY: true,

  // Split when gap between messages exceeds this (milliseconds)
  MAX_GAP_MS: 4 * 60 * 60 * 1000, // 4 hours

  // Minimum messages per conversation
  MIN_MESSAGES: 3,

  // Maximum messages per conversation (to prevent huge artifacts)
  MAX_MESSAGES: 500,

  // Maximum time span per conversation (milliseconds)
  MAX_TIMESPAN_MS: 7 * 24 * 60 * 60 * 1000, // 7 days
};

function parseTimestamp(timestamp: string): Date {
  return new Date(timestamp);
}

function isNewDay(prevTime: Date, currentTime: Date): boolean {
  return (
    prevTime.getUTCDate() !== currentTime.getUTCDate() ||
    prevTime.getUTCMonth() !== currentTime.getUTCMonth() ||
    prevTime.getUTCFullYear() !== currentTime.getUTCFullYear()
  );
}

function getGapBetweenMessages(
  msg1: DiscordMessage,
  msg2: DiscordMessage
): number {
  const time1 = parseTimestamp(msg1.timestamp).getTime();
  const time2 = parseTimestamp(msg2.timestamp).getTime();
  return Math.abs(time2 - time1);
}

function extractThreadIds(messages: DiscordMessage[]): string[] {
  const threadIds = new Set<string>();

  for (const message of messages) {
    if (message.thread?.id) {
      threadIds.add(message.thread.id);
    }
    if (message.message_reference?.message_id) {
      // This is a reply, find the thread it belongs to
      const parentMessage = messages.find(
        (m) => m.id === message.message_reference?.message_id
      );
      if (parentMessage?.thread?.id) {
        threadIds.add(parentMessage.thread.id);
      }
    }
  }

  return Array.from(threadIds);
}

function extractParticipants(messages: DiscordMessage[]): string[] {
  const participants = new Set<string>();

  for (const message of messages) {
    const username = message.author.global_name || message.author.username;
    participants.add(username);
  }

  return Array.from(participants);
}

function splitByTemporalBoundaries(
  messages: DiscordMessage[]
): ConversationSplit[] {
  if (messages.length === 0) return [];

  const sortedMessages = [...messages].sort(
    (a, b) =>
      parseTimestamp(a.timestamp).getTime() -
      parseTimestamp(b.timestamp).getTime()
  );

  const splits: ConversationSplit[] = [];
  let currentSplit: DiscordMessage[] = [];
  let lastMessageTime: Date | null = null;

  for (const message of sortedMessages) {
    const messageTime = parseTimestamp(message.timestamp);

    // Check for daily boundary
    if (lastMessageTime && isNewDay(lastMessageTime, messageTime)) {
      if (currentSplit.length >= SPLIT_CONFIG.MIN_MESSAGES) {
        splits.push(createSplitFromMessages(currentSplit, "temporal"));
      }
      currentSplit = [];
    }

    // Check for gap boundary
    if (
      lastMessageTime &&
      getGapBetweenMessages(
        { timestamp: lastMessageTime.toISOString() } as DiscordMessage,
        message
      ) > SPLIT_CONFIG.MAX_GAP_MS
    ) {
      if (currentSplit.length >= SPLIT_CONFIG.MIN_MESSAGES) {
        splits.push(createSplitFromMessages(currentSplit, "temporal"));
      }
      currentSplit = [];
    }

    // Check for maximum conversation size
    if (currentSplit.length >= SPLIT_CONFIG.MAX_MESSAGES) {
      splits.push(createSplitFromMessages(currentSplit, "temporal"));
      currentSplit = [];
    }

    currentSplit.push(message);
    lastMessageTime = messageTime;
  }

  // Add final split
  if (currentSplit.length >= SPLIT_CONFIG.MIN_MESSAGES) {
    splits.push(createSplitFromMessages(currentSplit, "temporal"));
  }

  return splits;
}

function createSplitFromMessages(
  messages: DiscordMessage[],
  splitType: "temporal" | "topic" | "thread"
): ConversationSplit {
  const sortedMessages = [...messages].sort(
    (a, b) =>
      parseTimestamp(a.timestamp).getTime() -
      parseTimestamp(b.timestamp).getTime()
  );

  const startTime = sortedMessages[0].timestamp;
  const endTime = sortedMessages[sortedMessages.length - 1].timestamp;
  const participants = extractParticipants(messages);
  const threadIds = extractThreadIds(messages);

  return {
    id: `split_${startTime}_${endTime}`.replace(/[:.]/g, "_"),
    startTime,
    endTime,
    messageCount: messages.length,
    participantCount: participants.length,
    threadCount: threadIds.length,
    participants,
    threadIds,
    splitType,
    messages: sortedMessages,
  };
}

function preserveThreadIntegrity(
  splits: ConversationSplit[]
): ConversationSplit[] {
  const threadMap = new Map<string, ConversationSplit[]>();

  // Group splits by threads
  for (const split of splits) {
    for (const threadId of split.threadIds) {
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId)!.push(split);
    }
  }

  const adjustedSplits: ConversationSplit[] = [];
  const processedSplits = new Set<string>();

  for (const [threadId, threadSplits] of threadMap) {
    if (threadSplits.length > 1) {
      // Thread spans multiple splits - merge them
      const mergedMessages = threadSplits.flatMap((split) => split.messages);
      const mergedSplit = createSplitFromMessages(mergedMessages, "thread");
      mergedSplit.parentSplitId = threadSplits[0].id;

      adjustedSplits.push(mergedSplit);
      threadSplits.forEach((split) => processedSplits.add(split.id));
    }
  }

  // Add non-thread splits that weren't merged
  for (const split of splits) {
    if (!processedSplits.has(split.id)) {
      adjustedSplits.push(split);
    }
  }

  return adjustedSplits;
}

function generateConversationTitle(split: ConversationSplit): string {
  const date = new Date(split.startTime);
  const dateStr = date.toISOString().split("T")[0];

  if (split.threadCount > 0) {
    return `Discord Discussion - ${dateStr} (${split.threadCount} threads, ${split.participantCount} participants)`;
  }

  return `Discord Chat - ${dateStr} (${split.participantCount} participants)`;
}

async function convertSplitToMarkdown(
  split: ConversationSplit
): Promise<string> {
  // Use the existing discord-to-markdown conversion logic
  // but only for messages in this split
  const { discordJsonToMarkdown } = await import("./discord-to-markdown");
  return discordJsonToMarkdown(split.messages);
}

export function splitDiscordConversations(
  messages: DiscordMessage[]
): ConversationSplit[] {
  // Step 1: Temporal splitting
  const temporalSplits = splitByTemporalBoundaries(messages);

  // Step 2: Preserve thread integrity
  const threadAwareSplits = preserveThreadIntegrity(temporalSplits);

  return threadAwareSplits;
}

export async function createConversationArtifacts(
  splits: ConversationSplit[],
  sourceId: number,
  channelId: string,
  guildId: string
): Promise<ConversationArtifact[]> {
  const artifacts: ConversationArtifact[] = [];

  for (const split of splits) {
    const content = await convertSplitToMarkdown(split);
    artifacts.push({
      id: `discord_${channelId}_${split.id}`,
      sourceId,
      kind: "discord_conversation" as const,
      providerId: `${channelId}_${split.id}`,
      title: generateConversationTitle(split),
      content,
      contentFormat: "markdown" as const,
      metadata: {
        channelId,
        guildId,
        splitType: split.splitType,
        threadIds: split.threadIds,
        participants: split.participants,
        messageCount: split.messageCount,
        timeSpan: {
          start: split.startTime,
          end: split.endTime,
        },
      },
    });
  }

  return artifacts;
}

export async function processDiscordExport(
  messages: DiscordMessage[],
  sourceId: number,
  channelId: string,
  guildId: string
): Promise<ConversationArtifact[]> {
  const splits = splitDiscordConversations(messages);
  return await createConversationArtifacts(
    splits,
    sourceId,
    channelId,
    guildId
  );
}
