import { db } from "@/db";
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
  sourceID: number
): Promise<string | null> {
  const lastArtifact = await db
    .selectFrom("artifacts")
    .selectAll()
    .where("sourceID", "=", sourceID)
    .orderBy("createdAt", "desc")
    .executeTakeFirst();

  if (!lastArtifact) {
    console.log("No last artifact found");
    return null;
  }

  const metadataKey = `${lastArtifact.bucketPath}metadata.json`;
  const metadataFile = await env.MACHINEN_BUCKET.get(metadataKey);

  if (!metadataFile) {
    return null;
  }

  const metadata = await metadataFile.json<{
    lastMessageID?: string;
  }>();
  return metadata.lastMessageID || null;
}

async function ingestMessagesForSource(
  config: DiscordIngestionConfig
): Promise<{
  artifactID?: number;
  messageCount: number;
}> {
  const numOfMessages = 10;
  const lastMessageID = await getLastIngestedMessageID(config.sourceID);

  console.log(`Starting ingestion for sourceID ${config.sourceID}`);
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

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bucketPath = `discord/${config.guildID}/${config.channelID}/${timestamp}/`;

  const messagesKey = `${bucketPath}messages.json`;
  await env.MACHINEN_BUCKET.put(
    messagesKey,
    JSON.stringify(allMessages, null, 2)
  );

  const readableContent = allMessages
    .map((msg) => {
      const date = new Date(msg.timestamp).toISOString();
      const username =
        msg.author.username || msg.author.global_name || "Unknown";
      return `[${date}] ${username}: ${msg.content}`;
    })
    .join("\n");

  const readableKey = `${bucketPath}messages.txt`;
  await env.MACHINEN_BUCKET.put(readableKey, readableContent);

  const metadata = {
    messageCount: allMessages.length,
    lastMessageID: allMessages[0]?.id,
    firstMessageID: allMessages[allMessages.length - 1]?.id,
    channelID: config.channelID,
    guildID: config.guildID,
    ingestedAt: new Date().toISOString(),
  };

  const metadataKey = `${bucketPath}metadata.json`;
  await env.MACHINEN_BUCKET.put(metadataKey, JSON.stringify(metadata, null, 2));

  const result = await db
    .insertInto("artifacts")
    .values({
      // @ts-ignore
      id: null,
      sourceID: config.sourceID,
      bucketPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return {
    artifactID: result.id,
    messageCount: allMessages.length,
  };
}

export async function ingestDiscordMessages(): Promise<
  Array<{ sourceID: number; result: any }>
> {
  const sources = await db
    .selectFrom("sources")
    .selectAll()
    .where("type", "=", "discord")
    .execute();

  const results = [];

  for (const source of sources) {
    try {
      const botToken = (env as any).DISCORD_BOT_TOKEN as string | undefined;
      if (!botToken) {
        throw new Error("DISCORD_BOT_TOKEN environment variable not set");
      }

      const metadata = source.description as unknown as {
        guildID: string;
        channelID: string;
      };
      const { guildID, channelID } = metadata;

      if (!guildID || !channelID) {
        throw new Error(
          `Source ${source.id} missing guildID or channelID in description`
        );
      }

      console.log("Ingesting Discord messages for source", source.id);

      const result = await ingestMessagesForSource({
        sourceID: source.id,
        guildID,
        channelID,
        botToken,
      });
      console.log('-"'.repeat(80));
      console.log(result);
      console.log('-"'.repeat(80));

      results.push({ sourceID: source.id, result });
    } catch (error) {
      console.error(`Error ingesting Discord source ${source.id}:`, error);
      results.push({
        sourceID: source.id,
        result: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return results;
}
