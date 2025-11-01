import { rawDiscordDb } from "./db";
import { env } from "cloudflare:workers";

interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    global_name?: string;
  };
  channel_id: string;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  thread?: {
    id: string;
    name: string;
  };
}

interface DiscordIngestionConfig {
  sourceID: number;
  guildID: string;
  channelID: string;
  botToken: string;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMessages(
  channelID: string,
  botToken: string,
  limit = 100,
  beforeID?: string,
  retryCount = 0
): Promise<DiscordMessage[]> {
  const url = new URL(
    `https://discord.com/api/v10/channels/${channelID}/messages`
  );
  url.searchParams.set("limit", limit.toString());
  if (beforeID) {
    url.searchParams.set("before", beforeID);
  }

  console.log("-".repeat(80));
  console.log(`Fetching messages from channel ${channelID}`);
  console.log(`Limit: ${limit}, Before: ${beforeID || "none"}`);
  console.log("-".repeat(80));

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });

  const remaining = response.headers.get("X-RateLimit-Remaining");
  const resetAfter = response.headers.get("X-RateLimit-Reset-After");

  console.log(`Rate limit remaining: ${remaining}`);
  console.log(`Rate limit reset after: ${resetAfter}s`);

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitTime = retryAfter
      ? parseFloat(retryAfter) * 1000
      : Math.pow(2, retryCount) * 1000;

    console.log(
      `Rate limited! Waiting ${waitTime}ms before retry (attempt ${
        retryCount + 1
      })`
    );

    if (retryCount >= 3) {
      throw new Error("Max retries reached after rate limiting");
    }

    await sleep(waitTime);
    return fetchMessages(channelID, botToken, limit, beforeID, retryCount + 1);
  }

  if (!response.ok) {
    throw new Error(
      `Discord API error: ${response.status} ${response.statusText}`
    );
  }

  if (remaining === "0" && resetAfter) {
    const waitTime = parseFloat(resetAfter) * 1000;
    console.log(
      `Rate limit reached. Waiting ${waitTime}ms before next request`
    );
    await sleep(waitTime);
  }

  return response.json();
}

async function getLastIngestedMessageID(
  channelID: string,
  guildID: string
): Promise<string | null> {
  const lastMessage = await rawDiscordDb
    .selectFrom("raw_discord_messages")
    .selectAll()
    .where("channel_id", "=", channelID)
    .where("guild_id", "=", guildID)
    .orderBy("timestamp", "desc")
    .executeTakeFirst();

  return lastMessage?.message_id || null;
}

async function ingestMessagesForSource(
  config: DiscordIngestionConfig
): Promise<{
  messageCount: number;
  firstMessageID?: string;
  lastMessageID?: string;
}> {
  const numOfMessages = 10;
  const lastMessageID = await getLastIngestedMessageID(
    config.channelID,
    config.guildID
  );

  console.log(`Starting ingestion for channel ${config.channelID}`);
  console.log(`Last ingested message ID: ${lastMessageID || "none"}`);

  const allMessages: DiscordMessage[] = [];
  let fetchedMessages = await fetchMessages(
    config.channelID,
    config.botToken,
    numOfMessages,
    lastMessageID || undefined
  );

  console.log(`Initial fetch returned ${fetchedMessages.length} messages`);
  if (fetchedMessages.length > 0) {
    console.log(
      `Message ID range: ${fetchedMessages[0].id} to ${
        fetchedMessages[fetchedMessages.length - 1].id
      }`
    );
  }

  let loopCount = 0;
  const maxLoops = 100;

  while (fetchedMessages.length > 0) {
    loopCount++;
    console.log(`Loop iteration ${loopCount}`);
    console.log(`Adding ${fetchedMessages.length} messages to collection`);
    console.log(`Total messages so far: ${allMessages.length}`);

    if (loopCount > maxLoops) {
      console.error(`Max loop iterations (${maxLoops}) reached, breaking`);
      break;
    }

    allMessages.push(...fetchedMessages);

    if (fetchedMessages.length < numOfMessages) {
      console.log(
        `Received fewer messages than requested (${fetchedMessages.length} < ${numOfMessages}), stopping`
      );
      break;
    }

    const oldestMessageID = fetchedMessages[fetchedMessages.length - 1].id;
    console.log(`Oldest message ID in current batch: ${oldestMessageID}`);
    console.log(
      `Fetching next batch of messages before ID: ${oldestMessageID}`
    );

    await sleep(500);

    fetchedMessages = await fetchMessages(
      config.channelID,
      config.botToken,
      numOfMessages,
      oldestMessageID
    );

    console.log(`Next batch returned ${fetchedMessages.length} messages`);
  }

  console.log(`Finished message collection after ${loopCount} iterations`);
  console.log(`Total messages collected: ${allMessages.length}`);

  if (allMessages.length === 0) {
    return { messageCount: 0 };
  }

  for (const message of allMessages) {
    await rawDiscordDb
      .insertInto("raw_discord_messages")
      .values({
        message_id: message.id,
        channel_id: message.channel_id,
        guild_id: config.guildID,
        author_id: message.author.id,
        content: message.content,
        timestamp: message.timestamp,
        thread_id: message.thread?.id || null,
        reply_to_message_id: message.message_reference?.message_id || null,
        reply_to_channel_id: message.message_reference?.channel_id || null,
        raw_data: JSON.stringify(message),
      })
      .execute();
  }

  return {
    messageCount: allMessages.length,
    firstMessageID: allMessages[0]?.id,
    lastMessageID: allMessages[allMessages.length - 1]?.id,
  };
}

export async function ingestDiscordMessages(): Promise<
  Array<{ channelID: string; guildID: string; result: any }>
> {
  const results = [];
  const botToken = (env as any).DISCORD_BOT_TOKEN as string | undefined;

  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN environment variable not set");
  }

  const results_placeholder = [
    {
      channelID: "1307974274145062912",
      guildID: "679514959968993311",
      config: {
        sourceID: 1,
        guildID: "679514959968993311",
        channelID: "1307974274145062912",
        botToken,
      },
    },
  ];

  for (const item of results_placeholder) {
    try {
      console.log(
        `Ingesting Discord messages for channel ${item.channelID} in guild ${item.guildID}`
      );

      const result = await ingestMessagesForSource(item.config);
      console.log("-".repeat(80));
      console.log(result);
      console.log("-".repeat(80));

      results.push({
        channelID: item.channelID,
        guildID: item.guildID,
        result,
      });
    } catch (error) {
      console.error(
        `Error ingesting Discord channel ${item.channelID}:`,
        error
      );
      results.push({
        channelID: item.channelID,
        guildID: item.guildID,
        result: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return results;
}
