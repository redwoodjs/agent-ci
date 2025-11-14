import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";
import { fetchChannelMessages } from "../utils/discord-api";

type DiscordMessage = components["schemas"]["MessageResponse"];

function getDailyR2Key(
  guildID: string,
  channelID: string,
  date: string
): string {
  return `discord/${guildID}/${channelID}/${date}.jsonl`;
}

function filterNonThreadMessages(messages: DiscordMessage[]): DiscordMessage[] {
  return messages.filter((message) => !message.thread);
}

function groupMessagesByDay(
  messages: DiscordMessage[]
): Map<string, DiscordMessage[]> {
  const messagesByDay = new Map<string, DiscordMessage[]>();

  for (const message of messages) {
    const date = message.timestamp.split("T")[0];
    if (!messagesByDay.has(date)) {
      messagesByDay.set(date, []);
    }
    messagesByDay.get(date)!.push(message);
  }

  return messagesByDay;
}

export async function processChannelEvent(
  guildID: string,
  channelID: string
): Promise<void> {
  console.log(
    `[channel-processor] Processing channel ${channelID} in guild ${guildID}`
  );

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
  const messagesByDay = groupMessagesByDay(channelMessages);

  console.log(
    `[channel-processor] Grouped ${channelMessages.length} messages into ${messagesByDay.size} days`
  );

  for (const [date, messages] of messagesByDay) {
    messages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const jsonl = messages.map((m) => JSON.stringify(m)).join("\n");
    const key = getDailyR2Key(guildID, channelID, date);

    await env.MACHINEN_BUCKET.put(key, jsonl);
    console.log(
      `[channel-processor] Wrote ${messages.length} messages to ${key}`
    );
  }

  console.log(
    `[channel-processor] Processed channel ${channelID}: ${channelMessages.length} messages across ${messagesByDay.size} days`
  );
}
