import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";
import { fetchChannelMessages } from "../utils/discord-api";
import { channelToJson, parseChannelFromJson } from "../utils/channel-to-json";
import { generateDiff } from "../utils/diff";

type DiscordMessage = components["schemas"]["MessageResponse"];

function getLatestR2Key(guildID: string, channelID: string): string {
  return `discord/${guildID}/${channelID}/latest.json`;
}

function getHistoryR2Key(
  guildID: string,
  channelID: string,
  timestampForFilename: string
): string {
  return `discord/${guildID}/${channelID}/history/${timestampForFilename}.json`;
}

function filterNonThreadMessages(messages: DiscordMessage[]): DiscordMessage[] {
  return messages.filter((message) => !message.thread);
}

export async function processChannelEvent(
  guildID: string,
  channelID: string
): Promise<void> {
  const latestR2Key = getLatestR2Key(guildID, channelID);

  console.log(`[channel-processor] Processing channel ${channelID} in guild ${guildID}`);

  let allMessages: DiscordMessage[];
  try {
    allMessages = await fetchChannelMessages(channelID);
  } catch (error) {
    console.error(
      `[channel-processor] Failed to fetch messages for channel ${channelID}:`,
      error
    );
    throw error;
  }

  const channelMessages = filterNonThreadMessages(allMessages);

  const now = new Date().toISOString();

  const existingLatestJson = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldChannel: { messages: DiscordMessage[] } | null = null;

  if (existingLatestJson) {
    const jsonText = await existingLatestJson.text();
    oldChannel = await parseChannelFromJson(jsonText);
  }

  const diff = generateDiff(
    oldChannel as unknown as Record<string, unknown> | null,
    { messages: channelMessages } as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${channelID}-${now}-${channelMessages.length}`;
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(versionHash)
  );
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const versionHashStr = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .substring(0, 16);

  const json = channelToJson(guildID, channelID, channelMessages, {
    guild_id: guildID,
    channel_id: channelID,
    created_at: channelMessages[0]?.timestamp || now,
    updated_at: now,
    version_hash: versionHashStr,
  });

  await env.MACHINEN_BUCKET.put(latestR2Key, JSON.stringify(json, null, 2));

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      guildID,
      channelID,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
    console.log(`[channel-processor] Stored history diff for channel ${channelID}`);
  }

  console.log(
    `[channel-processor] Processed channel ${channelID}: ${channelMessages.length} messages`
  );
}


