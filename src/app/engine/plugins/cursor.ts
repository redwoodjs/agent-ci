import {
  Plugin,
  IndexingHookContext,
  Document,
  Chunk,
  ChunkMetadata,
  QueryHookContext,
  CursorConversationLatestJson,
} from "../types";

interface CursorEvent {
  hook_event_name: string;
  prompt?: string;
  text?: string;
  [key: string]: any;
}

function normalizeCursorHandle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutAt = trimmed.replace(/^@+/, "");
  const cleaned = withoutAt.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) {
    return null;
  }
  return `@${cleaned}`;
}

function inferCursorUserHandle(
  data: CursorConversationLatestJson
): string | null {
  const email = (data as any)?.user_email;
  if (typeof email === "string") {
    const at = email.indexOf("@");
    const local = at > 0 ? email.slice(0, at) : email;
    const handle = normalizeCursorHandle(local);
    if (handle) {
      return handle;
    }
  }

  const roots: string[] = [];

  const rootsRaw = (data as any)?.workspace_roots;
  if (Array.isArray(rootsRaw)) {
    for (const root of rootsRaw) {
      if (typeof root === "string" && root.trim().length > 0) {
        roots.push(root.trim());
      }
    }
  }

  for (const gen of data.generations ?? []) {
    const events = Array.isArray((gen as any)?.events)
      ? (gen as any).events
      : [];
    for (const event of events) {
      const eventRoots = (event as any)?.workspace_roots;
      if (!Array.isArray(eventRoots)) {
        continue;
      }
      for (const root of eventRoots) {
        if (typeof root === "string" && root.trim().length > 0) {
          roots.push(root.trim());
        }
      }
    }
  }

  for (const root of roots) {
    const match = root.match(/\/Users\/([^\/]+)(\/|$)/);
    const handle = normalizeCursorHandle(match?.[1]);
    if (handle) {
      return handle;
    }
  }

  for (const gen of data.generations ?? []) {
    const events = Array.isArray((gen as any)?.events)
      ? (gen as any).events
      : [];
    for (const event of events) {
      const filePath = (event as any)?.file_path;
      if (typeof filePath !== "string") {
        continue;
      }
      const match = filePath.match(/\/Users\/([^\/]+)(\/|$)/);
      const handle = normalizeCursorHandle(match?.[1]);
      if (handle) {
        return handle;
      }
    }
  }

  return null;
}

export const cursorPlugin: Plugin = {
  name: "cursor",

  subjects: {
    async getMicroMomentBatchPromptContext(
      document: Document,
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<string | null> {
      if (document.source !== "cursor") {
        return null;
      }
      if (!chunks.every((c) => c.source === "cursor")) {
        return null;
      }

      return (
        `Context: These chunks are from a Cursor AI coding assistant conversation. Each chunk may include User and Assistant turns.\n` +
        `Attribute statements to the chunk author (author=...) when possible.\n` +
        `Focus on technical details, decisions, errors, file paths, commands, and outcomes.\n` +
        `Avoid claiming a change landed unless the text explicitly indicates it.\n`
      );
    },
    async getMacroSynthesisPromptContext(
      document: Document,
      context: IndexingHookContext
    ): Promise<string | null> {
      if (document.source !== "cursor") {
        return null;
      }

      const lines: string[] = [];
      lines.push("Formatting:");
      lines.push(`- title_label: [Cursor Conversation]`);
      lines.push(`- summary_descriptor: In a Cursor conversation,`);
      lines.push(
        `- canonical_token_note: omit canonical tokens for cursor in titles and summaries`
      );
      lines.push("");
      lines.push("Reference context:");
      lines.push(`- entity_hints:`);
      lines.push(`  - This document is a Cursor conversation.`);

      lines.push("");
      lines.push("Narrative context:");
      lines.push(
        `- This is a Cursor coding conversation. Prefer concrete technical phrasing and avoid claiming a change landed unless the text explicitly indicates it.`
      );
      return lines.join("\n");
    },
  },

  async prepareSourceDocument(
    context: IndexingHookContext
  ): Promise<Document | null> {
    if (!context.r2Key.startsWith("cursor/conversations/")) {
      return null;
    }

    const bucket = context.env.MACHINEN_BUCKET;
    const object = await bucket.get(context.r2Key);

    if (!object) {
      throw new Error(`R2 object not found: ${context.r2Key}`);
    }

    const jsonText = await object.text();
    const data = JSON.parse(jsonText) as CursorConversationLatestJson;
    const userHandle = inferCursorUserHandle(data);
    const workspaceRoots: string[] = [];
    const workspaceRootsSeen = new Set<string>();

    function addWorkspaceRoot(value: unknown) {
      if (typeof value !== "string") {
        return;
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return;
      }
      if (!workspaceRootsSeen.has(trimmed)) {
        workspaceRootsSeen.add(trimmed);
        workspaceRoots.push(trimmed);
      }
    }

    const workspaceRootsRaw = (data as any)?.workspace_roots;
    if (Array.isArray(workspaceRootsRaw)) {
      for (const root of workspaceRootsRaw) {
        addWorkspaceRoot(root);
      }
    }

    for (const gen of data.generations ?? []) {
      const events = Array.isArray((gen as any)?.events)
        ? (gen as any).events
        : [];
      for (const event of events) {
        const eventRoots = (event as any)?.workspace_roots;
        if (!Array.isArray(eventRoots)) {
          continue;
        }
        for (const root of eventRoots) {
          addWorkspaceRoot(root);
        }
      }
    }

    return {
      id: context.r2Key,
      source: "cursor",
      type: "cursor-conversation",
      content: `Cursor conversation ${data.id} with ${data.generations.length} turns.`,
      metadata: {
        title: `Cursor Conversation ${data.id}`,
        url: `cursor://conversation/${data.id}`,
        createdAt: new Date().toISOString(),
        author: userHandle ?? "cursor-user",
        sourceMetadata: {
          type: "cursor-conversation",
          conversationId: data.id,
          userHandle: userHandle ?? undefined,
          workspaceRoots:
            workspaceRoots.length > 0 ? workspaceRoots : undefined,
        },
      },
    };
  },

  async splitDocumentIntoChunks(
    document: Document,
    context: IndexingHookContext
  ): Promise<Chunk[]> {
    if (document.source !== "cursor") {
      return [];
    }

    const bucket = context.env.MACHINEN_BUCKET;
    const object = await bucket.get(document.id);
    if (!object) {
      throw new Error(`R2 object not found during chunking: ${document.id}`);
    }

    const jsonText = await object.text();
    const data = JSON.parse(jsonText) as CursorConversationLatestJson;

    const chunks: Chunk[] = [];
    const userAuthor =
      typeof document.metadata.author === "string" &&
      document.metadata.author.trim().length > 0
        ? document.metadata.author.trim()
        : "User";

    const encoder = new TextEncoder();
    async function hashContent(content: string): Promise<string> {
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    function readTrimmedString(value: unknown): string {
      if (typeof value !== "string") {
        return "";
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : "";
    }

    for (const [index, gen] of data.generations.entries()) {
      const userPrompt = readTrimmedString(
        gen.events.find(
          (e: CursorEvent) => e.hook_event_name === "beforeSubmitPrompt"
        )?.prompt
      );
      const assistantResponse = readTrimmedString(
        gen.events.find(
          (e: CursorEvent) => e.hook_event_name === "afterAgentResponse"
        )?.text
      );

      const baseJsonPath = `$.generations[${index}]`;
      const documentTitle =
        document.metadata.title ||
        `Cursor Conversation ${
          document.metadata.sourceMetadata?.conversationId || "unknown"
        }`;

      if (userPrompt) {
        const chunkId = `${document.id}#gen-${gen.id}-user`;
        const trimmedContent = `User: ${userPrompt}`;
        chunks.push({
          id: chunkId,
          documentId: document.id,
          source: "cursor",
          content: trimmedContent,
          contentHash: await hashContent(trimmedContent),
          metadata: {
            chunkId: chunkId,
            documentId: document.id,
            source: "cursor",
            type: "cursor-user-prompt",
            documentTitle,
            author: userAuthor,
            jsonPath: baseJsonPath,
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }

      if (assistantResponse) {
        const chunkId = `${document.id}#gen-${gen.id}-assistant`;
        const trimmedContent = `Assistant: ${assistantResponse}`;
        chunks.push({
          id: chunkId,
          documentId: document.id,
          source: "cursor",
          content: trimmedContent,
          contentHash: await hashContent(trimmedContent),
          metadata: {
            chunkId: chunkId,
            documentId: document.id,
            source: "cursor",
            type: "cursor-assistant-response",
            documentTitle,
            author: "Assistant",
            jsonPath: baseJsonPath,
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }
    }

    return chunks;
  },

  evidence: {
    async reconstructContext(
      documentChunks: ChunkMetadata[],
      sourceDocument: any,
      context: QueryHookContext
    ) {
      if (!documentChunks[0]) {
        return null;
      }
      const sourceMetadata = documentChunks[0].sourceMetadata;
      if (!sourceMetadata || sourceMetadata.type !== "cursor-conversation") {
        return null;
      }

      const data = sourceDocument as CursorConversationLatestJson;
      const sections: string[] = [];

      sections.push(`# Cursor Conversation ${data.id}\n`);

      const matchedIndices = new Set<number>();
      documentChunks.forEach((chunk) => {
        const match = chunk.jsonPath?.match(/generations\[(\d+)\]/);
        if (match) {
          matchedIndices.add(parseInt(match[1], 10));
        }
      });

      const sortedIndices = Array.from(matchedIndices).sort((a, b) => a - b);

      sortedIndices.forEach((index) => {
        const gen = data.generations[index];
        sections.push(`## Turn ${index + 1}`);
        sections.push("```json");
        sections.push(JSON.stringify(gen.events, null, 2));
        sections.push("```\n");
      });

      return {
        content: sections.join("\n"),
        source: "cursor",
        primaryMetadata: documentChunks[0],
      };
    },
  },
};
