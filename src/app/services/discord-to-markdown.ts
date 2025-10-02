type DiscordMessage = {
  id: string;
  type: number;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  channel_id: string;
  author: {
    id: string;
    username: string;
    global_name: string | null;
  };
  message_reference?: {
    message_id: string;
    channel_id: string;
    guild_id?: string;
  };
  thread?: {
    name: string;
    message_count: number;
    member_count: number;
  };
  reactions?: Array<{
    emoji: {
      name: string;
    };
    count: number;
  }>;
  attachments?: Array<{
    filename: string;
    size: number;
    url: string;
  }>;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
  }>;
};

type MessageNode = {
  message: DiscordMessage;
  children: MessageNode[];
  level: number;
};

function formatTimestamp(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function getUsername(author: DiscordMessage["author"]): string {
  return author.global_name || author.username;
}

function formatReactions(reactions: DiscordMessage["reactions"]): string {
  if (!reactions || reactions.length === 0) return "";

  const reactionStrings = reactions.map((r) => `${r.emoji.name} ${r.count}`);
  return `[reactions: ${reactionStrings.join(", ")}]`;
}

function formatAttachments(attachments: DiscordMessage["attachments"]): string {
  if (!attachments || attachments.length === 0) return "";

  const attachmentStrings = attachments.map(
    (a) => `[attachment: ${a.filename}, ${a.size} bytes, ${a.url}]`
  );
  return attachmentStrings.join("\n");
}

function formatEmbeds(embeds: DiscordMessage["embeds"]): string {
  if (!embeds || embeds.length === 0) return "";

  const embedStrings = embeds.map((e) => {
    const parts = [e.title, e.description, e.url].filter(Boolean);
    return `[embed: ${parts.join(", ")}]`;
  });
  return embedStrings.join("\n");
}

function formatThreadInfo(thread: DiscordMessage["thread"]): string {
  if (!thread) return "";

  return `[thread: "${thread.name}", ${thread.message_count} messages, ${thread.member_count} members]`;
}

function buildMessageTree(messages: DiscordMessage[]): MessageNode[] {
  const messageMap = new Map<string, MessageNode>();
  const rootNodes: MessageNode[] = [];

  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  for (const message of sortedMessages) {
    const node: MessageNode = {
      message,
      children: [],
      level: 0,
    };
    messageMap.set(message.id, node);
  }

  for (const message of sortedMessages) {
    const node = messageMap.get(message.id)!;

    if (message.message_reference?.message_id) {
      const parentNode = messageMap.get(message.message_reference.message_id);
      if (parentNode) {
        node.level = parentNode.level + 1;
        parentNode.children.push(node);
      } else {
        rootNodes.push(node);
      }
    } else {
      rootNodes.push(node);
    }
  }

  return rootNodes;
}

function formatMessageNode(node: MessageNode): string {
  const { message, level } = node;
  const lines: string[] = [];

  const indent = level > 0 ? "> ".repeat(level) : "";
  const timestamp = formatTimestamp(message.timestamp);
  const username = getUsername(message.author);

  let mainLine = `${indent}${timestamp} | ${username}: ${message.content}`;

  if (message.edited_timestamp) {
    const editedTime = formatTimestamp(message.edited_timestamp);
    mainLine += ` (edited ${editedTime})`;
  }

  lines.push(mainLine);

  const threadInfo = formatThreadInfo(message.thread);
  if (threadInfo) {
    lines.push(`${indent}${threadInfo}`);
  }

  const reactions = formatReactions(message.reactions);
  if (reactions) {
    lines.push(`${indent}${reactions}`);
  }

  const attachments = formatAttachments(message.attachments);
  if (attachments) {
    attachments.split("\n").forEach((line) => {
      lines.push(`${indent}${line}`);
    });
  }

  const embeds = formatEmbeds(message.embeds);
  if (embeds) {
    embeds.split("\n").forEach((line) => {
      lines.push(`${indent}${line}`);
    });
  }

  if (node.children.length > 0) {
    lines.push("");
    for (const child of node.children) {
      lines.push(formatMessageNode(child));
    }
  }

  return lines.join("\n");
}

function convertMessagesToMarkdown(messages: DiscordMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  const messageTree = buildMessageTree(messages);
  const formattedMessages = messageTree.map((node) => formatMessageNode(node));

  return formattedMessages.join("\n\n");
}

export function discordJsonToMarkdown(
  jsonData: DiscordMessage[] | string
): string {
  const messages: DiscordMessage[] =
    typeof jsonData === "string" ? JSON.parse(jsonData) : jsonData;

  return convertMessagesToMarkdown(messages);
}

export function generateMarkdownFilename(
  channelID: string,
  exportTimestamp?: string
): string {
  const timestamp =
    exportTimestamp || new Date().toISOString().replace(/[:.]/g, "-");
  return `discord_${channelID}_${timestamp}.md`;
}
