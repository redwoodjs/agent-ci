import { db } from "@/db";
import { env } from "cloudflare:workers";

interface DiscordMessage {
  id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
  };
  channel_id: string;
}

interface DiscordIngestionConfig {
  sourceID: number;
  guildID: string;
  channelID: string;
  botToken: string;
}

export class DiscordIngestorService {
  private config: DiscordIngestionConfig;

  constructor(config: DiscordIngestionConfig) {
    this.config = config;
  }

  async fetchMessages(
    limit = 100,
    beforeID?: string
  ): Promise<DiscordMessage[]> {
    const url = new URL(
      `https://discord.com/api/v10/channels/${this.config.channelID}/messages`
    );
    url.searchParams.set("limit", limit.toString());
    if (beforeID) {
      url.searchParams.set("before", beforeID);
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bot ${this.config.botToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Discord API error: ${response.status} ${response.statusText}`
      );
    }

    return response.json();
  }

  async getLastIngestedMessageID(): Promise<string | null> {
    const lastArtifact = await db
      .selectFrom("artifacts")
      .selectAll()
      .where("sourceID", "=", this.config.sourceID)
      .orderBy("createdAt", "desc")
      .executeTakeFirst();

    if (!lastArtifact) {
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

  async ingestMessages(): Promise<{
    artifactID?: number;
    messageCount: number;
  }> {
    const lastMessageID = await this.getLastIngestedMessageID();

    const allMessages: DiscordMessage[] = [];
    let fetchedMessages = await this.fetchMessages(
      100,
      lastMessageID || undefined
    );

    while (fetchedMessages.length > 0) {
      allMessages.push(...fetchedMessages);

      if (fetchedMessages.length < 100) {
        break;
      }

      const oldestMessageID = fetchedMessages[fetchedMessages.length - 1].id;
      fetchedMessages = await this.fetchMessages(100, oldestMessageID);
    }

    if (allMessages.length === 0) {
      return { messageCount: 0 };
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bucketPath = `discord/${this.config.guildID}/${this.config.channelID}/${timestamp}/`;

    const messagesKey = `${bucketPath}messages.json`;
    await env.MACHINEN_BUCKET.put(
      messagesKey,
      JSON.stringify(allMessages, null, 2)
    );

    const readableContent = allMessages
      .map((msg) => {
        const date = new Date(msg.timestamp).toISOString();
        return `[${date}] ${msg.author.username}: ${msg.content}`;
      })
      .join("\n");

    const readableKey = `${bucketPath}messages.txt`;
    await env.MACHINEN_BUCKET.put(readableKey, readableContent);

    const metadata = {
      messageCount: allMessages.length,
      lastMessageID: allMessages[0]?.id,
      firstMessageID: allMessages[allMessages.length - 1]?.id,
      channelID: this.config.channelID,
      guildID: this.config.guildID,
      ingestedAt: new Date().toISOString(),
    };

    const metadataKey = `${bucketPath}metadata.json`;
    await env.MACHINEN_BUCKET.put(
      metadataKey,
      JSON.stringify(metadata, null, 2)
    );

    const result = await db
      .insertInto("artifacts")
      .values({
        // @ts-ignore
        id: null,
        sourceID: this.config.sourceID,
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

      const metadata = JSON.parse(source.description || "{}");
      const { guildID, channelID } = metadata;

      if (!guildID || !channelID) {
        throw new Error(
          `Source ${source.id} missing guildID or channelID in description`
        );
      }

      const ingestor = new DiscordIngestorService({
        sourceID: source.id,
        guildID,
        channelID,
        botToken,
      });

      const result = await ingestor.ingestMessages();
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
