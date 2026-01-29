import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  ReconstructedContext,
} from "../types";
import type { components } from "../../ingestors/discord/discord-api-types";
import type { ThreadPage } from "../../ingestors/discord/utils/thread-to-json";

type DiscordMessage = components["schemas"]["MessageResponse"];

function isDiscordR2Key(r2Key: string): boolean {
  return (
    r2Key.startsWith("discord/") &&
    (r2Key.endsWith(".jsonl") || r2Key.endsWith("/latest.json"))
  );
}

function parseDiscordR2Key(r2Key: string):
  | {
      guildID: string;
      channelID: string;
      type: "channel";
      date: string;
    }
  | {
      guildID: string;
      channelID: string;
      threadID: string;
      type: "thread";
    }
  | null {
  // Channel JSONL: discord/{guildID}/{channelID}/{YYYY-MM-DD}.jsonl
  const channelMatch = r2Key.match(
    /^discord\/([^\/]+)\/([^\/]+)\/(\d{4}-\d{2}-\d{2})\.jsonl$/
  );
  if (channelMatch) {
    return {
      guildID: channelMatch[1],
      channelID: channelMatch[2],
      type: "channel" as const,
      date: channelMatch[3],
    };
  }

  // Thread JSON: discord/{guildID}/{channelID}/threads/{threadID}/latest.json
  const threadMatch = r2Key.match(
    /^discord\/([^\/]+)\/([^\/]+)\/threads\/([^\/]+)\/latest\.json$/
  );
  if (threadMatch) {
    return {
      guildID: threadMatch[1],
      channelID: threadMatch[2],
      threadID: threadMatch[3],
      type: "thread" as const,
    };
  }

  return null;
}

function extractJsonPath(obj: unknown, jsonPath: string): string | null {
  if (!jsonPath.startsWith("$.")) {
    return null;
  }

  const path = jsonPath.slice(2);
  const parts = path.split(/[\.\[\]]/).filter((p) => p !== "");

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current !== "object") {
      return null;
    }
    if (Array.isArray(current)) {
      const index = parseInt(part, 10);
      if (isNaN(index)) {
        return null;
      }
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  if (typeof current === "string") {
    return current;
  }
  if (typeof current === "object" && current !== null) {
    return JSON.stringify(current);
  }
  return String(current);
}

function getAuthorName(message: DiscordMessage): string {
  const username = message.author?.username;
  if (typeof username === "string" && username.trim().length > 0) {
    const trimmed = username.trim().replace(/^@+/, "");
    if (trimmed) {
      return `@${trimmed}`;
    }
  }
  return message.author?.global_name || "unknown";
}

export const discordPlugin: Plugin = {
  name: "discord",

  subjects: {
    async getMicroMomentBatchPromptContext(
      document: Document,
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<string | null> {
      if (document.source !== "discord") {
        return null;
      }
      if (!chunks.every((c) => c.source === "discord")) {
        return null;
      }

      const chunkTypes = chunks
        .map((c) => (c.metadata as any)?.type)
        .filter(
          (t) => typeof t === "string" && t.trim().length > 0
        ) as string[];

      const isThreadBatch =
        chunkTypes.length > 0 &&
        chunkTypes.every((t) => t.startsWith("thread-"));
      const isChannelBatch =
        chunkTypes.length > 0 &&
        chunkTypes.every((t) => t.startsWith("channel-"));

      if (isThreadBatch) {
        return (
          `Context: These chunks are from a Discord thread.\n` +
          `Prefer wording like "discussed", "suggested", "asked", "decided", "agreed" unless a concrete action is explicitly described.\n` +
          `Attribute statements to the chunk author (author=...) when possible.\n`
        );
      }

      if (isChannelBatch) {
        return (
          `Context: These chunks are from a Discord channel log.\n` +
          `Prefer wording like "discussed", "suggested", "asked", "decided", "agreed" unless a concrete action is explicitly described.\n`
        );
      }

      return (
        `Context: These chunks are from Discord.\n` +
        `Attribute statements to the chunk author (author=...) when possible.\n` +
        `Prefer discussion framing unless a concrete action is explicitly described.\n`
      );
    },
    async getMacroSynthesisPromptContext(
      document: Document,
      context: IndexingHookContext
    ): Promise<string | null> {
      if (document.source !== "discord") {
        return null;
      }

      const sourceMetadata = document.metadata.sourceMetadata ?? {};
      const type = String(sourceMetadata.type ?? "");

      const lines: string[] = [];

      lines.push("Formatting:");

      if (type === "discord-thread") {
        lines.push(`- title_label: [Discord Thread]`);
        lines.push(`- summary_descriptor: In a Discord thread,`);
        lines.push(
          "- when_referencing_thread_use: mchn://dc/thread/<guildid>/<channelid>/<threadid>"
        );
        lines.push(
          "- when_referencing_thread_message_use: mchn://dc/thread_message/<guildid>/<channelid>/<threadid>/<messageid>"
        );

        lines.push("");
        lines.push("Reference context:");

        const guildID = String(sourceMetadata.guildID ?? "");
        const channelID = String(sourceMetadata.channelID ?? "");
        const threadID = String(sourceMetadata.threadID ?? "");

        if (guildID && channelID && threadID) {
          lines.push(
            `- document_ref: mchn://dc/thread/${guildID}/${channelID}/${threadID}`
          );
        }

        const raw = document.metadata._rawJson as ThreadPage | undefined;
        const messageIds =
          raw?.messages?.map((m) => m.id).filter(Boolean) ?? [];
        const maxMessageRefs = 10;
        const messageIdsLimited = messageIds.slice(0, maxMessageRefs);
        if (guildID && channelID && threadID && messageIdsLimited.length > 0) {
          lines.push(`- known_message_refs:`);
          for (const messageId of messageIdsLimited) {
            lines.push(
              `  - mchn://dc/thread_message/${guildID}/${channelID}/${threadID}/${messageId}`
            );
          }
          if (messageIds.length > messageIdsLimited.length) {
            lines.push(
              `  - (truncated: ${
                messageIds.length - messageIdsLimited.length
              } more)`
            );
          }
        }

        lines.push(`- entity_hints:`);
        lines.push(`  - This is a Discord thread with the ids above.`);

        lines.push("");
        lines.push("Narrative context:");
        lines.push(
          `- This is a Discord thread. Attribute statements to participants when possible.`
        );
        lines.push(
          `- Prefer wording like "discussed", "suggested", "asked", "decided", "agreed" unless a concrete action is explicitly described.`
        );

        return lines.join("\n");
      }

      if (type === "discord-channel") {
        lines.push(`- title_label: [Discord Channel]`);
        lines.push(`- summary_descriptor: In a Discord channel,`);
        lines.push(
          "- when_referencing_channel_day_use: mchn://dc/channel_day/<guildid>/<channelid>/<yyyy-mm-dd>"
        );
        lines.push(
          "- when_referencing_channel_message_use: mchn://dc/channel_message/<guildid>/<channelid>/<yyyy-mm-dd>/<messageid>"
        );

        lines.push("");
        lines.push("Reference context:");

        const guildID = String(sourceMetadata.guildID ?? "");
        const channelID = String(sourceMetadata.channelID ?? "");
        const date = String(sourceMetadata.date ?? "");
        if (guildID && channelID && date) {
          lines.push(
            `- document_ref: mchn://dc/channel_day/${guildID}/${channelID}/${date}`
          );
        }

        const raw = document.metadata._rawJson as
          | { messages: DiscordMessage[] }
          | undefined;
        const messageIds =
          raw?.messages?.map((m) => m.id).filter(Boolean) ?? [];
        const maxMessageRefs = 10;
        const messageIdsLimited = messageIds.slice(0, maxMessageRefs);
        if (guildID && channelID && date && messageIdsLimited.length > 0) {
          lines.push(`- known_message_refs:`);
          for (const messageId of messageIdsLimited) {
            lines.push(
              `  - mchn://dc/channel_message/${guildID}/${channelID}/${date}/${messageId}`
            );
          }
          if (messageIds.length > messageIdsLimited.length) {
            lines.push(
              `  - (truncated: ${
                messageIds.length - messageIdsLimited.length
              } more)`
            );
          }
        }

        lines.push(`- entity_hints:`);
        lines.push(
          `  - This is a Discord channel day file with the ids above.`
        );

        lines.push("");
        lines.push("Narrative context:");
        lines.push(
          `- This is a Discord channel log. Treat it as discussion unless a concrete action is explicitly described.`
        );

        return lines.join("\n");
      }

      lines.push(`- title_label: [Discord]`);
      lines.push(`- summary_descriptor: In Discord,`);
      lines.push("");
      lines.push("Reference context:");
      lines.push(`- entity_hints:`);
      lines.push(`  - This document is from Discord.`);

      lines.push("");
      lines.push("Narrative context:");
      lines.push(`- This is Discord content.`);

      return lines.join("\n");
    },
  },

  async prepareSourceDocument(
    context: IndexingHookContext
  ): Promise<Document | null> {
    if (!isDiscordR2Key(context.r2Key)) {
      return null;
    }

    const parsed = parseDiscordR2Key(context.r2Key);
    if (!parsed) {
      return null;
    }

    const bucket = context.env.MACHINEN_BUCKET;
    const object = await bucket.get(context.r2Key);

    if (!object) {
      throw new Error(`R2 object not found: ${context.r2Key}`);
    }

    if (parsed.type === "channel") {
      // For channel JSONL files, combine all messages into a single document
      const jsonlText = await object.text();
      const lines = jsonlText
        .trim()
        .split("\n")
        .filter((line: string) => line.trim());
      const messages: DiscordMessage[] = lines.map((line: string) =>
        JSON.parse(line)
      );

      if (messages.length === 0) {
        return null;
      }

      // Create a combined content from all messages
      const combinedContent = messages
        .map((msg) => {
          const author = getAuthorName(msg);
          const time = new Date(msg.timestamp).toLocaleString();
          return `[${time}] ${author}: ${msg.content || ""}`;
        })
        .join("\n");

      const firstMessage = messages[0];
      const lastMessage = messages[messages.length - 1];

      return {
        id: context.r2Key,
        source: "discord",
        type: "channel-messages",
        content: combinedContent,
        metadata: {
          title: `Discord Channel Messages - ${parsed.date}`,
          url: `discord://channel/${parsed.guildID}/${parsed.channelID}`,
          createdAt: firstMessage.timestamp,
          author: getAuthorName(firstMessage),
          _rawJson: { messages, parsed },
          sourceMetadata: {
            type: "discord-channel",
            guildID: parsed.guildID,
            channelID: parsed.channelID,
            date: parsed.date,
          },
        },
      };
    } else {
      // For thread JSON files, parse the ThreadPage structure
      const jsonText = await object.text();
      const threadPage = JSON.parse(jsonText) as ThreadPage;

      // Create combined content from starter message and all replies
      const starterContent = `[${new Date(
        threadPage.starter_message.timestamp
      ).toLocaleString()}] ${getAuthorName(threadPage.starter_message)}: ${
        threadPage.starter_message.content || ""
      }`;
      const messagesContent = threadPage.messages
        .map((msg) => {
          const author = getAuthorName(msg);
          const time = new Date(msg.timestamp).toLocaleString();
          return `[${time}] ${author}: ${msg.content || ""}`;
        })
        .join("\n");

      const combinedContent = `${starterContent}\n${messagesContent}`;

      return {
        id: context.r2Key,
        source: "discord",
        type: "thread",
        content: combinedContent,
        metadata: {
          title: `Discord Thread - ${threadPage.metadata.thread_id}`,
          url: `discord://channel/${parsed.guildID}/${parsed.channelID}/thread/${parsed.threadID}`,
          createdAt: threadPage.metadata.created_at,
          author: getAuthorName(threadPage.starter_message),
          _rawJson: threadPage,
          sourceMetadata: {
            type: "discord-thread",
            guildID: parsed.guildID,
            channelID: parsed.channelID,
            threadID: parsed.threadID,
          },
        },
      };
    }
  },

  async splitDocumentIntoChunks(
    document: Document,
    context: IndexingHookContext
  ): Promise<Chunk[] | null> {
    if (document.source !== "discord") {
      return null;
    }

    const parsed = parseDiscordR2Key(context.r2Key);
    if (!parsed) {
      return null;
    }

    const chunks: Chunk[] = [];

    if (parsed.type === "channel") {
      const data = document.metadata._rawJson as
        | { messages: DiscordMessage[]; parsed: typeof parsed }
        | undefined;
      if (!data) {
        throw new Error(
          `Document metadata missing _rawJson for ${context.r2Key}`
        );
      }

      // Create one chunk per message
      for (let i = 0; i < data.messages.length; i++) {
        const message = data.messages[i];
        if (!message.content || message.content.trim() === "") {
          continue;
        }

        chunks.push({
          id: `${context.r2Key}#message-${message.id}`,
          documentId: context.r2Key,
          source: "discord",
          content: message.content,
          metadata: {
            chunkId: `${context.r2Key}#message-${message.id}`,
            documentId: context.r2Key,
            source: "discord",
            type: "channel-message",
            documentTitle: document.metadata.title,
            author: getAuthorName(message),
            jsonPath: `$.messages[${i}].content`,
            timestamp: message.timestamp,
            messageId: message.id,
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }
    } else {
      const threadPage = document.metadata._rawJson as ThreadPage | undefined;
      if (!threadPage) {
        throw new Error(
          `Document metadata missing _rawJson for ${context.r2Key}`
        );
      }

      // Create chunk for starter message
      if (threadPage.starter_message.content) {
        chunks.push({
          id: `${context.r2Key}#starter`,
          documentId: context.r2Key,
          source: "discord",
          content: threadPage.starter_message.content,
          metadata: {
            chunkId: `${context.r2Key}#starter`,
            documentId: context.r2Key,
            source: "discord",
            type: "thread-starter",
            documentTitle: document.metadata.title,
            author: getAuthorName(threadPage.starter_message),
            jsonPath: "$.starter_message.content",
            timestamp: threadPage.starter_message.timestamp,
            messageId: threadPage.starter_message.id,
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }

      // Create chunks for each reply message
      for (let i = 0; i < threadPage.messages.length; i++) {
        const message = threadPage.messages[i];
        if (!message.content || message.content.trim() === "") {
          continue;
        }

        chunks.push({
          id: `${context.r2Key}#message-${message.id}`,
          documentId: context.r2Key,
          source: "discord",
          content: message.content,
          metadata: {
            chunkId: `${context.r2Key}#message-${message.id}`,
            documentId: context.r2Key,
            source: "discord",
            type: "thread-message",
            documentTitle: document.metadata.title,
            author: getAuthorName(message),
            jsonPath: `$.messages[${i}].content`,
            timestamp: message.timestamp,
            messageId: message.id,
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }
    }

    return chunks;
  },

  evidence: {
    async buildVectorSearchFilter(
      context: QueryHookContext
    ): Promise<Record<string, unknown> | null> {
      return null;
    },

    async reconstructContext(
      documentChunks: ChunkMetadata[],
      sourceDocument:
        | ThreadPage
        | { messages: DiscordMessage[]; parsed: any }
        | string,
      context: QueryHookContext
    ): Promise<ReconstructedContext | null> {
      if (documentChunks.length === 0) {
        return null;
      }

      const firstChunk = documentChunks[0];
      const sourceMetadata = firstChunk.sourceMetadata;

      if (!sourceMetadata || firstChunk.source !== "discord") {
        return null;
      }

      // For JSONL files, the engine will pass the raw text as a string
      // For thread JSON files, the engine will pass the parsed JSON object
      const documentId = firstChunk.documentId;
      if (!documentId) {
        return null;
      }

      let parsedDocument:
        | ThreadPage
        | { messages: DiscordMessage[]; parsed: any };

      if (documentId.endsWith(".jsonl")) {
        // JSONL files are passed as raw text string from the engine
        if (typeof sourceDocument === "string") {
          const lines = sourceDocument
            .trim()
            .split("\n")
            .filter((line) => line.trim());
          const messages: DiscordMessage[] = lines.map((line) =>
            JSON.parse(line)
          );
          const parsed = parseDiscordR2Key(documentId);
          if (!parsed || parsed.type !== "channel") {
            return null;
          }
          parsedDocument = { messages, parsed };
        } else {
          // Fallback: re-read the file if we didn't get a string
          const bucket = context.env.MACHINEN_BUCKET;
          const object = await bucket.get(documentId);
          if (!object) {
            return null;
          }
          const text = await object.text();
          const lines = text
            .trim()
            .split("\n")
            .filter((line: string) => line.trim());
          const messages: DiscordMessage[] = lines.map((line: string) =>
            JSON.parse(line)
          );
          const parsed = parseDiscordR2Key(documentId);
          if (!parsed || parsed.type !== "channel") {
            return null;
          }
          parsedDocument = { messages, parsed };
        }
      } else {
        // For thread JSON files, use the parsed document from the engine
        if (!sourceDocument || typeof sourceDocument === "string") {
          // Fallback: re-read if parsing failed
          const bucket = context.env.MACHINEN_BUCKET;
          const object = await bucket.get(documentId);
          if (!object) {
            return null;
          }
          const text = await object.text();
          parsedDocument = JSON.parse(text) as ThreadPage;
        } else {
          parsedDocument = sourceDocument as ThreadPage;
        }
      }

      const docSections: string[] = [];

      if (sourceMetadata.type === "discord-channel") {
        const channelData = parsedDocument as {
          messages: DiscordMessage[];
          parsed: { guildID: string; channelID: string; date: string };
        };
        docSections.push(
          `## Discord Channel Messages - ${channelData.parsed.date}`
        );
        docSections.push(
          `**Guild ID:** ${channelData.parsed.guildID} | **Channel ID:** ${channelData.parsed.channelID}`
        );

        for (const chunk of documentChunks) {
          if (!chunk.jsonPath) {
            continue;
          }
          const content = extractJsonPath(parsedDocument, chunk.jsonPath);
          if (content) {
            const timestamp = chunk.timestamp
              ? new Date(chunk.timestamp as string).toLocaleString()
              : "unknown time";
            const author = chunk.author || "unknown";
            docSections.push(`\n**[${timestamp}] ${author}:**\n${content}`);
          }
        }
      } else if (sourceMetadata.type === "discord-thread") {
        const threadDoc = parsedDocument as ThreadPage;
        docSections.push(`## Discord Thread`);
        docSections.push(
          `**Guild ID:** ${threadDoc.metadata.guild_id} | **Channel ID:** ${threadDoc.metadata.channel_id} | **Thread ID:** ${threadDoc.metadata.thread_id}`
        );
        docSections.push(
          `**Created:** ${new Date(
            threadDoc.metadata.created_at
          ).toLocaleString()} | **Updated:** ${new Date(
            threadDoc.metadata.updated_at
          ).toLocaleString()}`
        );

        // Add starter message
        const starterChunk = documentChunks.find(
          (c) => c.type === "thread-starter"
        );
        if (starterChunk && starterChunk.jsonPath) {
          const content = extractJsonPath(
            parsedDocument,
            starterChunk.jsonPath
          );
          if (content) {
            const timestamp = starterChunk.timestamp
              ? new Date(starterChunk.timestamp as string).toLocaleString()
              : "unknown time";
            const author = starterChunk.author || "unknown";
            docSections.push(
              `\n**Starter Message [${timestamp}] ${author}:**\n${content}`
            );
          }
        }

        // Add thread messages
        const messageChunks = documentChunks.filter(
          (c) => c.type === "thread-message"
        );
        for (const chunk of messageChunks) {
          if (!chunk.jsonPath) {
            continue;
          }
          const content = extractJsonPath(parsedDocument, chunk.jsonPath);
          if (content) {
            const timestamp = chunk.timestamp
              ? new Date(chunk.timestamp as string).toLocaleString()
              : "unknown time";
            const author = chunk.author || "unknown";
            docSections.push(`\n**[${timestamp}] ${author}:**\n${content}`);
          }
        }
      }

      const content = docSections.join("\n");

      return {
        content,
        source: "discord",
        primaryMetadata: firstChunk,
      };
    },

    async composeLlmPrompt(
      contexts: ReconstructedContext[],
      query: string,
      context: QueryHookContext
    ): Promise<string> {
      const discordContexts = contexts.filter(
        (ctx) => ctx.source === "discord"
      );
      if (discordContexts.length === 0) {
        return "";
      }

      const contextSection = discordContexts
        .map((ctx) => ctx.content)
        .join("\n\n---\n\n");

      return `## Discord Context\n\n${contextSection}`;
    },
  },
};
