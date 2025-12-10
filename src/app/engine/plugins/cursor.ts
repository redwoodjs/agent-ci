import {
  Plugin,
  IndexingHookContext,
  Document,
  Chunk,
  ChunkMetadata,
  QueryHookContext,
  MomentDescription,
  CursorConversationLatestJson,
} from "../types";
import { generateTitleForText } from "../utils/summarize";
import { callLLM } from "../utils/llm";
import { getEmbedding, cosineSimilarity } from "../utils/vector";
import {
  getDocumentStructureHash,
  setDocumentStructureHash,
  clearDocumentStructureHash,
} from "../momentDb";
import {
  getExchangeCache,
  setExchangeCache,
  clearExchangeCache,
} from "../cursorDb";

interface CursorEvent {
  hook_event_name: string;
  prompt?: string;
  text?: string;
  [key: string]: any;
}

function extractUserPrompts(data: CursorConversationLatestJson): string[] {
  const prompts: string[] = [];
  for (const gen of data.generations) {
    const userPrompt =
      gen.events.find(
        (e: CursorEvent) =>
          e.hook_event_name === "beforeSubmitPrompt" && e.prompt
      )?.prompt || "";
    if (userPrompt.trim()) {
      prompts.push(userPrompt.trim());
    }
  }
  return prompts;
}

// Define a type for an exchange with its summary and embedding
interface Exchange {
  content: string;
  summary: string;
  embedding: number[];
  createdAt: string;
  author: string;
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
    async extractMomentsFromDocument(
      document: Document,
      context: IndexingHookContext
    ): Promise<MomentDescription[] | null> {
      if (document.source !== "cursor") {
        return null;
      }

      // TEMPORARY: Clear caches for testing
      await clearExchangeCache();
      await clearDocumentStructureHash();
      console.log("[cursor-plugin] Cleared all caches for testing");

      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(document.id);
      if (!object) {
        throw new Error(`R2 object not found: ${document.id}`);
      }
      const jsonText = await object.text();
      console.log(
        `[cursor-plugin] Fetched R2 object, length: ${
          jsonText.length
        }, first 100 chars: ${jsonText.substring(0, 100)}`
      );
      let data: CursorConversationLatestJson;
      try {
        data = JSON.parse(jsonText) as CursorConversationLatestJson;
      } catch (error) {
        console.error(
          `[cursor-plugin] Failed to parse JSON for ${
            document.id
          }. JSON text length: ${
            jsonText.length
          }, first 200 chars: ${jsonText.substring(0, 200)}`
        );
        throw error;
      }
      console.log(
        `[cursor-plugin] Parsed JSON successfully. Generations count: ${
          data.generations?.length || 0
        }`
      );

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
        console.log(
          `[cursor-plugin] Conversation structure unchanged (hash: ${structureHash.substring(
            0,
            8
          )}...). Skipping moment extraction.`
        );
        return null;
      }

      // Bulk-fetch cached exchanges
      const cachedExchanges = await getExchangeCache(generationIds);
      console.log(
        `[cursor-plugin] Found ${cachedExchanges.size}/${generationIds.length} cached exchanges`
      );

      const exchanges: Exchange[] = [];
      const newCacheEntries: Array<{
        generationId: string;
        summary: string;
        embedding: number[];
      }> = [];

      // 1. First Pass: Summarize and embed each exchange (using cache when available)
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

        console.log(
          `[cursor-plugin] Generation ${
            gen.id
          }: userPrompt type=${typeof userPromptEvent?.prompt}, assistantResponse type=${typeof assistantResponseEvent?.text}`
        );

        if (!userPrompt.trim() && !assistantResponse.trim()) {
          console.log(
            `[cursor-plugin] Skipping generation ${gen.id} - both prompts empty`
          );
          continue;
        }

        let content = "";
        if (userPrompt) content += `User: ${userPrompt}\n`;
        if (assistantResponse) content += `Assistant: ${assistantResponse}`;

        if (!content.trim()) {
          continue;
        }

        // Check cache first
        const cached = cachedExchanges.get(gen.id);
        let summary: string;
        let embedding: number[];

        if (cached) {
          summary = cached.summary;
          embedding = cached.embedding;
          console.log(
            `[cursor-plugin] Using cached summary/embedding for generation ${gen.id}`
          );
        } else {
          // Generate new summary and embedding
          summary = await callLLM(
            `Summarize this exchange in one sentence: ${content}`,
            "gpt-oss-20b-cheap"
          );
          embedding = await getEmbedding(summary);

          // Add to cache entries for bulk write
          newCacheEntries.push({
            generationId: gen.id,
            summary,
            embedding,
          });
          console.log(
            `[cursor-plugin] Generated new summary/embedding for generation ${gen.id}`
          );
        }

        exchanges.push({
          content: content.trim(),
          summary,
          embedding,
          createdAt: new Date().toISOString(),
          author: "cursor-user",
        });
      }

      // Bulk-write new cache entries
      if (newCacheEntries.length > 0) {
        await setExchangeCache(newCacheEntries);
        console.log(
          `[cursor-plugin] Cached ${newCacheEntries.length} new exchanges`
        );
      }

      // Update structure hash
      await setDocumentStructureHash(document.id, structureHash);

      if (exchanges.length === 0) {
        return null;
      }

      // 2. Second Pass: Group exchanges by similarity
      const SIMILARITY_THRESHOLD = 0.7;
      console.log(
        `[cursor-plugin] Starting second pass: grouping ${exchanges.length} exchanges into moments (similarity threshold: ${SIMILARITY_THRESHOLD})`
      );
      const moments: MomentDescription[] = [];
      let currentMomentExchanges: Exchange[] = [exchanges[0]];

      for (let i = 1; i < exchanges.length; i++) {
        const prevEmbedding = exchanges[i - 1].embedding;
        const currentEmbedding = exchanges[i].embedding;
        const similarity = cosineSimilarity(prevEmbedding, currentEmbedding);

        if (similarity >= SIMILARITY_THRESHOLD) {
          currentMomentExchanges.push(exchanges[i]);
          console.log(
            `[cursor-plugin] Exchange ${i} added to current moment (similarity: ${similarity.toFixed(
              3
            )}, moment size: ${currentMomentExchanges.length})`
          );
        } else {
          // Consolidate the completed moment
          console.log(
            `[cursor-plugin] Similarity ${similarity.toFixed(
              3
            )} < threshold, consolidating moment with ${
              currentMomentExchanges.length
            } exchanges`
          );
          const momentContent = currentMomentExchanges
            .map((e) => e.content)
            .join("\n\n---\n\n");
          const momentTitle = await generateTitleForText(
            currentMomentExchanges.map((e) => e.summary).join(" ")
          );

          moments.push({
            title: momentTitle,
            content: momentContent,
            author: currentMomentExchanges[0].author,
            createdAt: currentMomentExchanges[0].createdAt,
            sourceMetadata: document.metadata.sourceMetadata,
          });
          console.log(
            `[cursor-plugin] Created moment ${moments.length}: "${momentTitle}" (${currentMomentExchanges.length} exchanges)`
          );

          // Start a new moment
          currentMomentExchanges = [exchanges[i]];
          console.log(`[cursor-plugin] Starting new moment with exchange ${i}`);
        }
      }

      // Consolidate the last moment
      if (currentMomentExchanges.length > 0) {
        console.log(
          `[cursor-plugin] Consolidating final moment with ${currentMomentExchanges.length} exchanges`
        );
        const momentContent = currentMomentExchanges
          .map((e) => e.content)
          .join("\n\n---\n\n");
        const momentTitle = await generateTitleForText(
          currentMomentExchanges.map((e) => e.summary).join(" ")
        );
        moments.push({
          title: momentTitle,
          content: momentContent,
          author: currentMomentExchanges[0].author,
          createdAt: currentMomentExchanges[0].createdAt,
          sourceMetadata: document.metadata.sourceMetadata,
        });
        console.log(
          `[cursor-plugin] Created final moment ${moments.length}: "${momentTitle}" (${currentMomentExchanges.length} exchanges)`
        );
      }

      console.log(
        `[cursor-plugin] Completed moment extraction: created ${moments.length} moments from ${exchanges.length} exchanges`
      );
      return moments.length > 0 ? moments : null;
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
