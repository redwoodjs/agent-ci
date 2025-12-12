import {
  Plugin,
  IndexingHookContext,
  Document,
  Chunk,
  ChunkMetadata,
  QueryHookContext,
  MicroMomentDescription,
  CursorConversationLatestJson,
} from "../types";
import {
  getDocumentStructureHash,
  setDocumentStructureHash,
} from "../momentDb";

interface CursorEvent {
  hook_event_name: string;
  prompt?: string;
  text?: string;
  [key: string]: any;
}

export const cursorPlugin: Plugin = {
  name: "cursor",

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

    return {
      id: context.r2Key,
      source: "cursor",
      type: "cursor-conversation",
      content: `Cursor conversation ${data.id} with ${data.generations.length} turns.`,
      metadata: {
        title: `Cursor Conversation ${data.id}`,
        url: `cursor://conversation/${data.id}`,
        createdAt: new Date().toISOString(),
        author: "cursor-user",
        sourceMetadata: {
          type: "cursor-conversation",
          conversationId: data.id,
        },
      },
    };
  },

  subjects: {
    async extractMicroMomentsFromDocument(
      document: Document,
      context: IndexingHookContext
    ): Promise<MicroMomentDescription[] | null> {
      if (document.source !== "cursor") {
        return null;
      }

      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(document.id);
      if (!object) {
        throw new Error(`R2 object not found: ${document.id}`);
      }
      const jsonText = await object.text();
      let data: CursorConversationLatestJson;
      try {
        data = JSON.parse(jsonText) as CursorConversationLatestJson;
      } catch (error) {
        console.error(
          `[cursor-plugin] Failed to parse JSON for ${document.id}. Error:`,
          error
        );
        throw error;
      }

      // Compute structure hash from all generation IDs
      const generationIds = data.generations.map((gen) => gen.id);
      const structureHashInput = generationIds.join(":");
      const encoder = new TextEncoder();
      const hashData = encoder.encode(structureHashInput);
      const hashBuffer = await crypto.subtle.digest("SHA-256", hashData);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const structureHash = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      // Check if conversation structure is unchanged
      const storedHash = await getDocumentStructureHash(document.id);
      if (storedHash === structureHash) {
        return null;
      }

      // Update structure hash
      await setDocumentStructureHash(document.id, structureHash);

      // Extract micro-moments (one per generation/exchange)
      const microMoments: MicroMomentDescription[] = [];

      for (const gen of data.generations) {
        const userPromptEvent = gen.events.find(
          (e: CursorEvent) =>
            e.hook_event_name === "beforeSubmitPrompt" && e.prompt
        );
        const assistantResponseEvent = gen.events.find(
          (e: CursorEvent) =>
            e.hook_event_name === "afterAgentResponse" && e.text
        );

        const userPrompt =
          typeof userPromptEvent?.prompt === "string"
            ? userPromptEvent.prompt
            : "";
        const assistantResponse =
          typeof assistantResponseEvent?.text === "string"
            ? assistantResponseEvent.text
            : "";

        if (!userPrompt.trim() && !assistantResponse.trim()) {
          continue;
        }

        let content = "";
        if (userPrompt) content += `User: ${userPrompt}\n`;
        if (assistantResponse) content += `Assistant: ${assistantResponse}`;

        if (!content.trim()) {
          continue;
        }

        microMoments.push({
          path: gen.id,
          content: content.trim(),
          author: "cursor-user",
          createdAt: new Date().toISOString(),
          sourceMetadata: document.metadata.sourceMetadata,
        });
      }

      return microMoments.length > 0 ? microMoments : null;
    },

    async summarizeMomentContent(
      content: string,
      context: IndexingHookContext
    ): Promise<string> {
      const summaryPrompt = `Summarize the following content in one concise sentence describing what happened:\n\n${content}`;

      try {
        const { callLLM } = await import("../utils/llm");
        const summary = await callLLM(summaryPrompt, "gpt-oss-20b-cheap");
        return summary.trim();
      } catch (error) {
        console.error(`[cursor-plugin] Failed to generate summary:`, error);
        return `Content about: ${content.substring(0, 100)}...`;
      }
    },
  },

  evidence: {
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

      const encoder = new TextEncoder();
      async function hashContent(content: string): Promise<string> {
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      }

      for (const [index, gen] of data.generations.entries()) {
        const userPrompt =
          gen.events.find(
            (e: CursorEvent) =>
              e.hook_event_name === "beforeSubmitPrompt" && e.prompt
          )?.prompt || "";
        const assistantResponse =
          gen.events.find(
            (e: CursorEvent) =>
              e.hook_event_name === "afterAgentResponse" && e.text
          )?.text || "";

        let content = "";
        if (userPrompt) {
          content += `User: ${userPrompt}\n`;
        }

        if (assistantResponse) {
          content += `Assistant: ${assistantResponse}`;
        }

        if (!content.trim()) {
          continue;
        }

        if (content.trim()) {
          const chunkId = `${document.id}#gen-${gen.id}`;
          const trimmedContent = content.trim();
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
              type: "cursor-generation",
              documentTitle:
                document.metadata.title ||
                `Cursor Conversation ${
                  document.metadata.sourceMetadata?.conversationId || "unknown"
                }`,
              author: "cursor-user",
              jsonPath: `$.generations[${index}]`,
              sourceMetadata: document.metadata.sourceMetadata,
            },
          });
        }
      }

      return chunks;
    },

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
