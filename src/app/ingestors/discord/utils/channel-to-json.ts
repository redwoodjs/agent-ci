import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

export interface ChannelPageMetadata {
  guild_id: string;
  channel_id: string;
  created_at: string;
  updated_at: string;
  version_hash: string;
}

export interface ChannelPage {
  metadata: ChannelPageMetadata;
  messages: DiscordMessage[];
}

export function channelToJson(
  guildID: string,
  channelID: string,
  messages: DiscordMessage[],
  metadata: ChannelPageMetadata
): ChannelPage {
  return {
    metadata: {
      guild_id: guildID,
      channel_id: channelID,
      created_at: metadata.created_at,
      updated_at: metadata.updated_at,
      version_hash: metadata.version_hash,
    },
    messages: messages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    ),
  };
}

export async function parseChannelFromJson(
  jsonText: string
): Promise<{ messages: DiscordMessage[] } | null> {
  try {
    const parsed = JSON.parse(jsonText) as ChannelPage;
    return { messages: parsed.messages };
  } catch (error) {
    console.error("[channel-to-json] Failed to parse channel JSON:", error);
    return null;
  }
}


