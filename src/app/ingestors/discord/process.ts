"use server";

import { rawDiscordDb } from "./db";
import { db } from "@/db";
import { env } from "cloudflare:workers";

async function processUnprocessedMessages(): Promise<{
  processedCount: number;
  artifactsCreated: number;
}> {
  const unprocessedMessages = await rawDiscordDb
    .selectFrom("raw_discord_messages")
    .selectAll()
    .where("processed_state", "=", "unprocessed")
    .orderBy("timestamp", "asc")
    .execute();

  if (unprocessedMessages.length === 0) {
    console.log("No unprocessed messages found");
    return { processedCount: 0, artifactsCreated: 0 };
  }

  console.log(`Found ${unprocessedMessages.length} unprocessed messages`);

  const messagesByChannelAndGuild = new Map<
    string,
    (typeof unprocessedMessages)[0][]
  >();

  for (const message of unprocessedMessages) {
    const key = `${message.guild_id}#${message.channel_id}`;
    if (!messagesByChannelAndGuild.has(key)) {
      messagesByChannelAndGuild.set(key, []);
    }
    messagesByChannelAndGuild.get(key)!.push(message);
  }

  let artifactsCreated = 0;

  for (const [key, messages] of messagesByChannelAndGuild) {
    const [guildID, channelID] = key.split("#");

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const bucketPath = `discord/${guildID}/${channelID}/${timestamp}/`;

      const formattedMessages = messages.map((msg) => ({
        id: msg.message_id,
        content: msg.content,
        timestamp: msg.timestamp,
        author: {
          id: msg.author_id,
          username: "unknown",
        },
        channel_id: msg.channel_id,
      }));

      const messagesKey = `${bucketPath}messages.json`;
      await env.MACHINEN_BUCKET.put(
        messagesKey,
        JSON.stringify(formattedMessages, null, 2)
      );

      const readableContent = formattedMessages
        .map((msg) => {
          const date = new Date(msg.timestamp).toISOString();
          return `[${date}] ${msg.author.username}: ${msg.content}`;
        })
        .join("\n");

      const readableKey = `${bucketPath}messages.txt`;
      await env.MACHINEN_BUCKET.put(readableKey, readableContent);

      const metadata = {
        messageCount: messages.length,
        lastMessageID: messages[0]?.message_id,
        firstMessageID: messages[messages.length - 1]?.message_id,
        channelID,
        guildID,
        ingestedAt: new Date().toISOString(),
      };

      const metadataKey = `${bucketPath}metadata.json`;
      await env.MACHINEN_BUCKET.put(
        metadataKey,
        JSON.stringify(metadata, null, 2)
      );

      const sources = await db
        .selectFrom("sources")
        .selectAll()
        .where("type", "=", "discord")
        .execute();

      let sourceID = sources[0]?.id;
      if (!sourceID) {
        const newSource = await db
          .insertInto("sources")
          .values({
            type: "discord",
            name: `Discord ${channelID}`,
            description: JSON.stringify({ guildID, channelID }),
            bucket: "default",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        sourceID = newSource.id;
      }

      await rawDiscordDb
        .updateTable("raw_discord_messages")
        .set({ processed_state: "processed" })
        .where("guild_id", "=", guildID)
        .where("channel_id", "=", channelID)
        .execute();

      console.log(
        `Processed channel ${channelID} with ${messages.length} messages to ${bucketPath}`
      );
      artifactsCreated++;
    } catch (error) {
      console.error(`Error processing channel ${channelID}:`, error);
    }
  }

  return {
    processedCount: unprocessedMessages.length,
    artifactsCreated,
  };
}

export async function processDiscordMessages(): Promise<any> {
  try {
    const result = await processUnprocessedMessages();
    console.log("Processing result:", result);
    return result;
  } catch (error) {
    console.error("Error processing Discord messages:", error);
    throw error;
  }
}
