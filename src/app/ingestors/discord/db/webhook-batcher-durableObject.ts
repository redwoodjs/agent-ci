import { env } from "cloudflare:workers";
import type { components } from "../discord-api-types";

type DiscordMessage = components["schemas"]["MessageResponse"];

declare module "rwsdk/worker" {
  interface WorkerEnv {
    MACHINEN_BUCKET: R2Bucket;
    DISCORD_WEBHOOK_BATCHER: DurableObjectNamespace;
  }
}

interface BatcherEnv {
  MACHINEN_BUCKET: R2Bucket;
}

export class DiscordWebhookBatcherDO {
  private state: DurableObjectState;
  private env: BatcherEnv;
  private messages: DiscordMessage[] = [];
  private firstMessageTime: number | null = null;
  private alarmScheduled: boolean = false;
  private readonly BATCH_SIZE = 100;
  private readonly BATCH_TIMEOUT_MS = 60 * 1000; // 60 seconds

  constructor(state: DurableObjectState, env: BatcherEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname;

    if (action === "/add-message" && request.method === "POST") {
      const body = (await request.json()) as {
        message: DiscordMessage;
        fileKey: string;
      };
      const { message, fileKey } = body;
      await this.addMessage(message, fileKey);
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } else if (action === "/flush" && request.method === "POST") {
      await this.flush();
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    } else {
      return new Response("Not found", { status: 404 });
    }
  }

  private async addMessage(
    message: DiscordMessage,
    fileKey: string
  ): Promise<void> {
    // Skip thread messages - they're handled separately
    if (message.thread) {
      return;
    }

    // Store fileKey in persistent storage if not already stored
    const storedFileKey = await this.state.storage.get<string>("fileKey");
    if (!storedFileKey) {
      await this.state.storage.put("fileKey", fileKey);
    }

    if (this.messages.length === 0) {
      this.firstMessageTime = Date.now();
      // Schedule timeout flush
      const alarmTime = Date.now() + this.BATCH_TIMEOUT_MS;
      await this.state.storage.setAlarm(alarmTime);
      this.alarmScheduled = true;
    }

    this.messages.push(message);

    // Flush if batch size reached
    if (this.messages.length >= this.BATCH_SIZE) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.messages.length === 0) {
      // Cancel alarm if scheduled
      if (this.alarmScheduled) {
        try {
          await this.state.storage.deleteAlarm();
        } catch (e) {
          // Ignore if alarm doesn't exist
        }
        this.alarmScheduled = false;
      }
      return;
    }

    // Get fileKey from persistent storage
    const fileKey = await this.state.storage.get<string>("fileKey");
    if (!fileKey) {
      console.error("[webhook-batcher] No fileKey stored, cannot flush");
      this.messages = [];
      return;
    }

    const [guildID, channelID, date] = fileKey.split("/");
    const r2Key = `discord/${guildID}/${channelID}/${date}.jsonl`;

    // Read existing file
    let existingMessages: DiscordMessage[] = [];
    const existing = await this.env.MACHINEN_BUCKET.get(r2Key);
    if (existing) {
      const text = await existing.text();
      const lines = text
        .trim()
        .split("\n")
        .filter((line: string) => line.trim());
      existingMessages = lines.map(
        (line: string) => JSON.parse(line) as DiscordMessage
      );
    }

    // Append new messages
    const allMessages = [...existingMessages, ...this.messages];

    // Sort by timestamp
    allMessages.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    // Write back to R2
    const jsonl = allMessages.map((m) => JSON.stringify(m)).join("\n");
    await this.env.MACHINEN_BUCKET.put(r2Key, jsonl);

    console.log(
      `[webhook-batcher] Flushed ${this.messages.length} messages to ${r2Key}`
    );

    // Clear batch and cancel alarm
    this.messages = [];
    this.firstMessageTime = null;
    if (this.alarmScheduled) {
      try {
        await this.state.storage.deleteAlarm();
      } catch (e) {
        // Ignore if alarm doesn't exist
      }
      this.alarmScheduled = false;
    }
  }

  async alarm(): Promise<void> {
    // Flush if timeout exceeded
    if (
      this.firstMessageTime &&
      Date.now() - this.firstMessageTime >= this.BATCH_TIMEOUT_MS
    ) {
      await this.flush();
    }
  }
}
