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

function formatContent(message: DiscordMessage): string {
  const base = message.content ?? "";
  const replyMessageID = message.referenced_message?.id;
  if (!replyMessageID) {
    return base;
  }
  const suffix = `(reply to ${replyMessageID})`;
  return base ? `${base} ${suffix}` : suffix;
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
): Promise<string[]> {
  const file = await bucket.get(key);

  if (!file) {
    throw new Error(`File not found: ${key}`);
  }

  const contents = await file.text();
  return rawToTranscript(contents);
}
