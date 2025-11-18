import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";
import { fetchThreadMessages, fetchDiscordEntity } from "../utils/discord-api";
import { threadToJson, parseThreadFromJson } from "../utils/thread-to-json";
import { generateDiff } from "../utils/diff";

type DiscordMessage = components["schemas"]["MessageResponse"];

function getLatestR2Key(
  guildID: string,
  channelID: string,
  threadID: string
): string {
  return `discord/${guildID}/${channelID}/threads/${threadID}/latest.json`;
}

function getHistoryR2Key(
  guildID: string,
  channelID: string,
  threadID: string,
  timestampForFilename: string
): string {
  return `discord/${guildID}/${channelID}/threads/${threadID}/history/${timestampForFilename}.json`;
}

export async function processThreadEvent(
  guildID: string,
  channelID: string,
  threadID: string,
  starterMessageID?: string
): Promise<void> {
  const latestR2Key = getLatestR2Key(guildID, channelID, threadID);

  console.log(
    `[thread-processor] Processing thread ${threadID} in channel ${channelID}, guild ${guildID}`
  );

  let starterMessage: DiscordMessage;
  if (starterMessageID) {
    try {
      starterMessage = await fetchDiscordEntity<DiscordMessage>(
        `https://discord.com/api/v10/channels/${channelID}/messages/${starterMessageID}`
      );
    } catch (error) {
      console.error(
        `[thread-processor] Failed to fetch starter message ${starterMessageID}:`,
        error
      );
      throw error;
    }
  } else {
    const threadMessages = await fetchThreadMessages(threadID);
    if (threadMessages.length === 0) {
      console.warn(`[thread-processor] Thread ${threadID} has no messages, skipping`);
      return;
    }
    starterMessage = threadMessages[0];
  }

  let threadMessages: DiscordMessage[];
  try {
    threadMessages = await fetchThreadMessages(threadID);
  } catch (error) {
    console.error(
      `[thread-processor] Failed to fetch messages for thread ${threadID}:`,
      error
    );
    throw error;
  }

  const now = new Date().toISOString();

  const existingLatestJson = await env.MACHINEN_BUCKET.get(latestR2Key);
  let oldThread: { starterMessage: DiscordMessage; messages: DiscordMessage[] } | null = null;

  if (existingLatestJson) {
    const jsonText = await existingLatestJson.text();
    oldThread = await parseThreadFromJson(jsonText);
  }

  const diff = generateDiff(
    oldThread as unknown as Record<string, unknown> | null,
    { starterMessage, messages: threadMessages } as unknown as Record<string, unknown>
  );
  const hasChanges = diff !== null && Object.keys(diff.changes).length > 0;

  const versionHash = `${threadID}-${now}-${threadMessages.length}`;
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

  const json = threadToJson(
    guildID,
    channelID,
    threadID,
    starterMessage,
    threadMessages,
    {
      guild_id: guildID,
      channel_id: channelID,
      thread_id: threadID,
      created_at: starterMessage.timestamp,
      updated_at: now,
      version_hash: versionHashStr,
    }
  );

  await env.MACHINEN_BUCKET.put(latestR2Key, JSON.stringify(json, null, 2));

  if (hasChanges && diff) {
    const historyR2Key = getHistoryR2Key(
      guildID,
      channelID,
      threadID,
      diff.timestampForFilename
    );
    await env.MACHINEN_BUCKET.put(historyR2Key, JSON.stringify(diff, null, 2));
    console.log(`[thread-processor] Stored history diff for thread ${threadID}`);
  }

  console.log(
    `[thread-processor] Processed thread ${threadID}: ${threadMessages.length} messages`
  );
}


