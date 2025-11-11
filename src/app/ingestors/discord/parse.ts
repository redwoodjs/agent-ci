import { fetchOpenAiVectorString } from "@/lib/vectorize";
import { env } from "cloudflare:workers";

type DiscordAuthor = {
  username: string;
};

type DiscordMessage = {
  id: string;
  timestamp: string;
  content?: string;
  author: DiscordAuthor;
  referenced_message?: {
    id?: string;
    author?: DiscordAuthor;
  };
};

type ParsedMessage = {
  timestamp: string;
  username: string;
  messageID: string;
  content: string;
  embedding: number[];
};

function formatContent(message: DiscordMessage): string {
  const base = message.content ?? "";
  const replyMessageID = message.referenced_message?.id;
  if (!replyMessageID) {
    return base;
  }
  const suffix = `(reply to ${replyMessageID})`;
  return base ? `${base} ${suffix}` : suffix;
}

export async function rawToTranscriptWithEmbeddings(
  contents: string
): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const data = JSON.parse(line) as DiscordMessage;
    const timestamp = data.timestamp;
    const username = data.author?.username;
    const messageID = data.id;

    if (!username || !messageID) {
      continue;
    }

    const content = formatContent(data);
    if (!content) {
      continue;
    }

    const embeddingString = await fetchOpenAiVectorString(
      content,
      env.OPENAI_API_KEY
    );
    const embedding = JSON.parse(embeddingString) as number[];

    messages.push({
      timestamp,
      username,
      messageID,
      content,
      embedding,
    });
  }
  return messages;
}

export function rawToTranscript(contents: string): string[] {
  const formatted: string[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const data = JSON.parse(line) as DiscordMessage;
    const timestamp = data.timestamp;
    const username = data.author?.username;
    const messageID = data.id;

    if (!username || !messageID) {
      continue;
    }

    const content = formatContent(data);
    const prefix = `[${timestamp}][${username}][${messageID}]`;
    formatted.push(content ? `${prefix} ${content}` : prefix);
  }
  return formatted;
}

export async function parseDiscordFromR2(
  bucket: R2Bucket,
  key: string
): Promise<ParsedMessage[]> {
  const file = await bucket.get(key);

  if (!file) {
    throw new Error(`File not found: ${key}`);
  }

  const contents = await file.text();
  return rawToTranscriptWithEmbeddings(contents);
}
