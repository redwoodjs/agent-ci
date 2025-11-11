import { env } from "cloudflare:workers";
import type { components } from "./discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

interface IngestOptions {
  guildID: string;
  channelID: string;
  date?: string;
  startDate?: string;
  endDate?: string;
}

interface IngestResult {
  days: number;
  totalMessages: number;
  totalThreads: number;
  totalThreadMessages: number;
  files: string[];
}

async function fetchMessagesFromDiscord(
  channelID: string,
  options?: { before?: string; after?: string }
): Promise<DiscordMessage[]> {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN environment variable not set");
  }

  const params = new URLSearchParams({ limit: "100" });
  if (options?.before) params.set("before", options.before);
  if (options?.after) params.set("after", options.after);

  const url = `https://discord.com/api/v10/channels/${channelID}/messages?${params}`;

  let retries = 0;
  while (retries < 3) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${botToken}`,
      },
    });

    if (response.status === 429) {
      const rateLimitData = (await response.json()) as { retry_after?: number };
      const retryAfter = (rateLimitData.retry_after || 1) * 1000;
      console.warn(`Rate limited, retrying after ${retryAfter}ms`);
      await new Promise<void>((resolve) => setTimeout(resolve, retryAfter));
      retries++;
      continue;
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Discord API error: ${response.status} ${response.statusText} - ${error}`
      );
    }

    const rateLimitRemaining = response.headers.get("X-RateLimit-Remaining");
    if (rateLimitRemaining && parseInt(rateLimitRemaining) < 5) {
      console.warn(
        `Discord API rate limit low: ${rateLimitRemaining} requests remaining`
      );
    }

    return await response.json();
  }

  throw new Error("Max retries exceeded for rate limiting");
}

function isMessageInDateRange(
  message: DiscordMessage,
  options: IngestOptions
): boolean {
  const messageDate = message.timestamp.split("T")[0];

  if (options.date) {
    return messageDate === options.date;
  }

  if (options.startDate && options.endDate) {
    return messageDate >= options.startDate && messageDate <= options.endDate;
  }

  return true;
}

function shouldContinueFetching(
  message: DiscordMessage,
  options: IngestOptions
): boolean {
  const messageDate = message.timestamp.split("T")[0];

  if (options.date) {
    return messageDate >= options.date;
  }

  if (options.startDate) {
    return messageDate >= options.startDate;
  }

  return true;
}

function extractThreadInfo(messages: DiscordMessage[]): Map<string, string> {
  const threadToDate = new Map<string, string>();

  for (const message of messages) {
    if (message.thread?.id) {
      const date = message.timestamp.split("T")[0];
      threadToDate.set(message.thread.id, date);
    }
  }

  return threadToDate;
}

async function fetchThreadMessages(
  threadID: string
): Promise<DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let before: string | undefined = undefined;

  while (true) {
    const messages = await fetchMessagesFromDiscord(threadID, { before });

    if (messages.length === 0) {
      break;
    }

    allMessages.push(...messages);
    before = messages[messages.length - 1].id;

    console.log(
      `Fetched ${messages.length} thread messages, total: ${allMessages.length}`
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }

  allMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return allMessages;
}

export async function ingestDiscordMessages(
  options: IngestOptions
): Promise<IngestResult> {
  const { guildID, channelID } = options;

  console.log(
    `Fetching Discord messages for channel ${channelID} in guild ${guildID}`
  );
  if (options.date) {
    console.log(`Filtering for date: ${options.date}`);
  } else if (options.startDate && options.endDate) {
    console.log(
      `Filtering for date range: ${options.startDate} to ${options.endDate}`
    );
  }

  const allMessages: DiscordMessage[] = [];
  let before: string | undefined = undefined;
  let continueReading = true;

  while (continueReading) {
    const messages = await fetchMessagesFromDiscord(channelID, { before });

    if (messages.length === 0) {
      break;
    }

    for (const message of messages) {
      if (!shouldContinueFetching(message, options)) {
        continueReading = false;
        break;
      }

      if (isMessageInDateRange(message, options)) {
        allMessages.push(message);
      }
    }

    before = messages[messages.length - 1].id;

    console.log(
      `Fetched ${messages.length} messages, total collected: ${allMessages.length}`
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }

  console.log(`Total messages collected: ${allMessages.length}`);

  const messagesByDay = new Map<string, DiscordMessage[]>();

  for (const message of allMessages) {
    const date = message.timestamp.split("T")[0];
    if (!messagesByDay.has(date)) {
      messagesByDay.set(date, []);
    }
    messagesByDay.get(date)!.push(message);
  }

  console.log(`Grouped into ${messagesByDay.size} days`);

  const files: string[] = [];

  for (const [date, messages] of messagesByDay) {
    messages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const jsonl = messages.map((m) => JSON.stringify(m)).join("\n");
    const key = `discord/${guildID}/${channelID}/${date}.jsonl`;

    await env.MACHINEN_BUCKET.put(key, jsonl);
    files.push(key);

    console.log(`Wrote ${messages.length} messages to ${key}`);
  }

  const threadToDate = extractThreadInfo(allMessages);
  console.log(`Found ${threadToDate.size} threads`);

  let totalThreadMessages = 0;

  for (const [threadID, date] of threadToDate) {
    console.log(`Fetching thread ${threadID} from ${date}`);
    const threadMessages = await fetchThreadMessages(threadID);

    if (threadMessages.length > 0) {
      const jsonl = threadMessages.map((m) => JSON.stringify(m)).join("\n");
      const key = `discord/${guildID}/${channelID}/${date}-thread-${threadID}.jsonl`;

      await env.MACHINEN_BUCKET.put(key, jsonl);
      files.push(key);

      totalThreadMessages += threadMessages.length;
      console.log(`Wrote ${threadMessages.length} messages to ${key}`);
    }
  }

  return {
    days: messagesByDay.size,
    totalMessages: allMessages.length,
    totalThreads: threadToDate.size,
    totalThreadMessages,
    files,
  };
}
