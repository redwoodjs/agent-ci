import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

export interface ThreadPageMetadata {
  guild_id: string;
  channel_id: string;
  thread_id: string;
  created_at: string;
  updated_at: string;
  version_hash: string;
}

export interface ThreadPage {
  metadata: ThreadPageMetadata;
  starter_message: DiscordMessage;
  messages: DiscordMessage[];
}

export function threadToJson(
  guildID: string,
  channelID: string,
  threadID: string,
  starterMessage: DiscordMessage,
  messages: DiscordMessage[],
  metadata: ThreadPageMetadata
): ThreadPage {
  return {
    metadata: {
      guild_id: guildID,
      channel_id: channelID,
      thread_id: threadID,
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
      version_hash: metadata.version_hash,
    },
    starter_message: starterMessage,
    messages: messages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    ),
  };
}

export async function parseThreadFromJson(
  jsonText: string
): Promise<{ starterMessage: DiscordMessage; messages: DiscordMessage[] } | null> {
  try {
    const parsed = JSON.parse(jsonText) as ThreadPage;
    return {
      starterMessage: parsed.starter_message,
      messages: parsed.messages,
    };
  } catch (error) {
    console.error("[thread-to-json] Failed to parse thread JSON:", error);
    return null;
  }
}


