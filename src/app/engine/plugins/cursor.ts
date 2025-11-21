import { Plugin, IndexingHookContext, Document, Chunk } from "../../types";

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
    
    console.log(`[cursor-plugin] Loaded conversation with ${data.generations.length} generations`);

    // For the document content, we'll use a summary or the full text.
    // Since this is for the 'document' level, let's just say it's a conversation.
    // The chunks are what matter for search.
    return {
      id: context.r2Key,
      source: "cursor",
      content: `Cursor conversation ${data.id} with ${data.generations.length} turns.`,
      metadata: {
        title: `Cursor Conversation ${data.id}`,
        createdAt: new Date().toISOString(), // We could dig for a timestamp in events
        sourceMetadata: {
          type: "cursor-conversation",
          conversationId: data.id,
        },
      },
    };
  },

  async splitDocumentIntoChunks(
    document: Document,
    context: IndexingHookContext
  ): Promise<Chunk[]> {
    if (document.source !== "cursor") {
      return null; // Not handled by this plugin
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
      // Extract text from events
      const promptEvent = gen.events.find((e: any) => e.hook_event_name === "beforeSubmitPrompt");
      const responseEvent = gen.events.find((e: any) => e.hook_event_name === "afterAgentResponse");
      
      let textContent = "";
      
      if (promptEvent?.prompt) {
        textContent += `User: ${promptEvent.prompt}\n\n`;
      }
      
      if (responseEvent?.text) {
        textContent += `Assistant: ${responseEvent.text}`;
      }
      
      // Fallback: if we couldn't extract structured text, stringify the events
      if (!textContent.trim()) {
        textContent = JSON.stringify(gen.events);
      }

      chunks.push({
        content: textContent,
        metadata: {
          ...document.metadata,
          type: "cursor-generation",
          chunkId: `${document.id}#gen-${gen.id}`,
          jsonPath: `$.generations[${index}]`,
          documentId: document.id,
        },
      });
    });

    console.log(`[cursor-plugin] Created ${chunks.length} chunks from ${data.generations.length} generations`);
    
    return chunks;
  },

  async reconstructContext(
    documentChunks: Chunk[],
    sourceDocument: any, // This is the raw JSON
    context: IndexingHookContext
  ) {
     const { sourceMetadata } = documentChunks[0].metadata;
    if (sourceMetadata?.type !== 'cursor-conversation') {
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
    documentChunks.forEach(chunk => {
        const match = chunk.metadata.jsonPath?.match(/generations\[(\d+)\]/);
        if (match) {
            matchedIndices.add(parseInt(match[1], 10));
        }
    });

    // We want to show the conversation in order, but maybe only the relevant parts?
    // Or should we show the surrounding context?
    // For now, let's just show the matched generations.
    
    // Sort indices
    const sortedIndices = Array.from(matchedIndices).sort((a, b) => a - b);

    sortedIndices.forEach(index => {
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
      primaryMetadata: documentChunks[0].metadata,
    };
  }
};

