import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_BOT_TOKEN: string;
  }
}

export async function fetchDiscordEntity<T>(url: string): Promise<T> {
  const botToken = env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN environment variable not set");
  }

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
      console.warn(`[discord-api] Rate limited, retrying after ${retryAfter}ms`);
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

    return await response.json();
  }

  throw new Error("Max retries exceeded for rate limiting");
}

export async function fetchChannelMessages(
  channelID: string
): Promise<DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let before: string | undefined = undefined;

  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);

    const url = `https://discord.com/api/v10/channels/${channelID}/messages?${params}`;
    const messages = await fetchDiscordEntity<DiscordMessage[]>(url);

    if (messages.length === 0) {
      break;
    }

    allMessages.push(...messages);
    before = messages[messages.length - 1].id;

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }

  return allMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}

export async function fetchThreadMessages(
  threadID: string
): Promise<DiscordMessage[]> {
  const allMessages: DiscordMessage[] = [];
  let before: string | undefined = undefined;

  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (before) params.set("before", before);

    const url = `https://discord.com/api/v10/channels/${threadID}/messages?${params}`;
    const messages = await fetchDiscordEntity<DiscordMessage[]>(url);

    if (messages.length === 0) {
      break;
    }

    allMessages.push(...messages);
    before = messages[messages.length - 1].id;

    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }

  return allMessages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );
}


