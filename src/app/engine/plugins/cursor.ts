import {
  Plugin,
  IndexingHookContext,
  Document,
  Chunk,
  ChunkMetadata,
  QueryHookContext,
} from "../types";

interface CursorConversationLatestJson {
  id: string;
  generations: {
    id: string;
    events: any[];
  }[];
}

export const cursorPlugin: Plugin = {
  name: "cursor",

  async prepareSourceDocument(
    context: IndexingHookContext
  ): Promise<Document | null> {
    if (!context.r2Key.startsWith("cursor/conversations/")) {
      return null;
    }

    console.log(`[cursor-plugin] Preparing document for: ${context.r2Key}`);

    const bucket = context.env.MACHINEN_BUCKET;
    const object = await bucket.get(context.r2Key);

    if (!object) {
      throw new Error(`R2 object not found: ${context.r2Key}`);
    }

    const jsonText = await object.text();
    const data = JSON.parse(jsonText) as CursorConversationLatestJson;

    console.log(
      `[cursor-plugin] Loaded conversation with ${data.generations.length} generations`
    );

    // For the document content, we'll use a summary or the full text.
    // Since this is for the 'document' level, let's just say it's a conversation.
    // The chunks are what matter for search.
    return {
      id: context.r2Key,
      source: "cursor",
      type: "cursor-conversation",
      content: `Cursor conversation ${data.id} with ${data.generations.length} turns.`,
      metadata: {
        title: `Cursor Conversation ${data.id}`,
        url: `cursor://conversation/${data.id}`,
        createdAt: new Date().toISOString(), // We could dig for a timestamp in events
        author: "cursor-user",
        sourceMetadata: {
          type: "cursor-conversation",
          conversationId: data.id,
        },
      },
    };
  },

  evidence: {
    async splitDocumentIntoChunks(
      document: Document,
      context: IndexingHookContext
    ): Promise<Chunk[]> {
      if (document.source !== "cursor") {
        return []; // Not handled by this plugin
      }

      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(document.id);
      if (!object) {
        throw new Error(`R2 object not found during chunking: ${document.id}`);
      }

      const jsonText = await object.text();
      const data = JSON.parse(jsonText) as CursorConversationLatestJson;

      const chunks: Chunk[] = [];

      data.generations.forEach((gen, index) => {
        const userPrompt =
          gen.events.find(
            (e) => e.hook_event_name === "beforeSubmitPrompt" && e.prompt
          )?.prompt || "";
        const assistantResponse =
          gen.events.find(
            (e) => e.hook_event_name === "afterAgentResponse" && e.text
          )?.text || "";

        console.log(
          `[cursor-plugin] Processing generation ${index + 1}/${
            data.generations.length
          }`
        );
        console.log(
          `[cursor-plugin]   - Extracted User Prompt (length): ${userPrompt.length}`
        );
        console.log(
          `[cursor-plugin]   - Extracted Assistant Response (length): ${assistantResponse.length}`
        );

        let content = "";
        if (userPrompt) {
          content += `User: ${userPrompt}\n`;
        }

        if (assistantResponse) {
          content += `Assistant: ${assistantResponse}`;
        }

        // Fallback: if we couldn't extract structured text, stringify the events
        if (!content.trim()) {
          content = JSON.stringify(gen.events);
        }

        if (content.trim()) {
          const chunkId = `${document.id}#gen-${gen.id}`;
          chunks.push({
            id: chunkId,
            documentId: document.id,
            source: "cursor",
            content: content.trim(),
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
              author: "cursor-user", // Cursor conversations don't have a specific author
              jsonPath: `$.generations[${index}]`,
              sourceMetadata: document.metadata.sourceMetadata,
              subjectId: document.subjectId,
            },
          });
        } else {
          console.log(
            `[cursor-plugin]   - SKIPPED: No content extracted for generation ${
              index + 1
            }. Raw events:`,
            JSON.stringify(gen.events)
          );
        }
      });

      console.log(
        `[cursor-plugin] Created ${chunks.length} chunks from ${data.generations.length} generations`
      );
      if (chunks.length > 0) {
        console.log(
          `[cursor-plugin] Sample chunk content (first 200 chars): ${chunks[0].content.substring(
            0,
            200
          )}`
        );
        console.log(
          `[cursor-plugin] Sample chunk content (last chunk, first 200 chars): ${chunks[
            chunks.length - 1
          ].content.substring(0, 200)}`
        );
      }

      return chunks;
    },

    async reconstructContext(
      documentChunks: ChunkMetadata[],
      sourceDocument: any, // This is the raw JSON
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

      // For each chunk found, we want to format its corresponding generation.
      // We can use the jsonPath to identify which generation it is.
      // Format: "$.generations[0]"

      // Get indices of generations that matched
      const matchedIndices = new Set<number>();
      documentChunks.forEach((chunk) => {
        const match = chunk.jsonPath?.match(/generations\[(\d+)\]/);
        if (match) {
          matchedIndices.add(parseInt(match[1], 10));
        }
      });

      // We want to show the conversation in order, but maybe only the relevant parts?
      // Or should we show the surrounding context?
      // For now, let's just show the matched generations.

      // Sort indices
      const sortedIndices = Array.from(matchedIndices).sort((a, b) => a - b);

      sortedIndices.forEach((index) => {
        const gen = data.generations[index];
        sections.push(`## Turn ${index + 1}`);

        // Attempt to format nicely
        // Since we don't know the exact event schema, we'll do a best-effort dump
        // formatted as a code block for readability.
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
