import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];
export type GatewayBotResponse = components["schemas"]["GatewayBotResponse"];
export type GatewayBotSessionStartLimitResponse =
  components["schemas"]["GatewayBotSessionStartLimitResponse"];

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_BOT_TOKEN: string;
  }
}

// Gateway Protocol Op Codes
export enum GatewayOpCode {
  DISPATCH = 0,
  HEARTBEAT = 1,
  IDENTIFY = 2,
  PRESENCE_UPDATE = 3,
  VOICE_STATE_UPDATE = 4,
  RESUME = 6,
  RECONNECT = 7,
  REQUEST_GUILD_MEMBERS = 8,
  INVALID_SESSION = 9,
  HELLO = 10,
  HEARTBEAT_ACK = 11,
}

// Gateway Intents
export enum GatewayIntent {
  GUILDS = 1 << 0,
  GUILD_MEMBERS = 1 << 1,
  GUILD_MODERATION = 1 << 2,
  GUILD_EMOJIS_AND_STICKERS = 1 << 3,
  GUILD_INTEGRATIONS = 1 << 4,
  GUILD_WEBHOOKS = 1 << 5,
  GUILD_INVITES = 1 << 6,
  GUILD_VOICE_STATES = 1 << 7,
  GUILD_PRESENCES = 1 << 8,
  GUILD_MESSAGES = 1 << 9,
  GUILD_MESSAGE_REACTIONS = 1 << 10,
  GUILD_MESSAGE_TYPING = 1 << 11,
  DIRECT_MESSAGES = 1 << 12,
  DIRECT_MESSAGE_REACTIONS = 1 << 13,
  DIRECT_MESSAGE_TYPING = 1 << 14,
  MESSAGE_CONTENT = 1 << 15,
  GUILD_SCHEDULED_EVENTS = 1 << 16,
  AUTO_MODERATION_CONFIGURATION = 1 << 20,
  AUTO_MODERATION_EXECUTION = 1 << 21,
  GUILD_MESSAGE_POLLS = 1 << 24,
  GUILD_MESSAGE_POLL_VOTES = 1 << 25,
}

// Gateway Event Types
// Note: These are not in the OpenAPI spec as they're part of the WebSocket protocol
export type GatewayEventType =
  | "MESSAGE_CREATE"
  | "MESSAGE_UPDATE"
  | "MESSAGE_DELETE"
  | "THREAD_CREATE"
  | "THREAD_UPDATE"
  | "THREAD_DELETE"
  | "THREAD_LIST_SYNC"
  | "THREAD_MEMBER_UPDATE"
  | "THREAD_MEMBERS_UPDATE";

// Gateway Message Types
// Note: These are WebSocket protocol types, not in the REST API OpenAPI spec
export interface GatewayMessage {
  op: GatewayOpCode;
  d?: any;
  s?: number | null;
  t?: GatewayEventType | null;
}

export interface GatewayHello {
  heartbeat_interval: number;
}

export interface GatewayIdentify {
  token: string;
  intents: number;
  properties: {
    os: string;
    browser: string;
    device: string;
  };
  compress?: boolean;
  large_threshold?: number;
  shard?: [number, number];
  presence?: any;
}

export interface GatewayResume {
  token: string;
  session_id: string;
  seq: number;
}

export async function fetchDiscordEntity<T>(url: string): Promise<T> {
  const botToken = (env as any).DISCORD_BOT_TOKEN as string;
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
      console.warn(
        `[discord-api] Rate limited, retrying after ${retryAfter}ms`
      );
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

// Returns the Gateway URL used by the DiscordGatewayDO.
// We now route the Gateway connection through an external proxy
// (see https://wsproxy-xx5hi.ondigitalocean.app/), which speaks
// the Discord Gateway protocol on our behalf.
//
// The rest of the ingestor still talks directly to the Discord
// HTTP API; only the WebSocket Gateway connection is proxied.
export async function fetchGatewayURL(): Promise<GatewayBotResponse> {
  // The proxy exposes a WebSocket-compatible endpoint at /gateway.
  // We include the standard Discord Gateway query params here so the
  // Durable Object can use the URL as-is.
  const proxyGatewayUrl =
    "wss://wsproxy-xx5hi.ondigitalocean.app/gateway?v=10&encoding=json";

  // We fabricate a minimal GatewayBotResponse compatible object.
  // The session_start_limit values are placeholders; the proxy is
  // responsible for enforcing any real Discord limits.
  return {
    url: proxyGatewayUrl,
    shards: 1,
    session_start_limit: {
      max_concurrency: 1,
      remaining: 1,
      total: 1,
      reset_after: 0,
    },
  };
}
