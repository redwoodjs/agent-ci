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

interface SynthesizedMoment {
  title: string;
  summary: string;
  content: string;
}

async function synthesizeMoments(
  microMoments: MomentDescription[],
  context: IndexingHookContext
): Promise<MomentDescription[]> {
  if (microMoments.length === 0) {
    return [];
  }

  console.log(
    `[cursor-plugin] Synthesizing ${microMoments.length} micro-moments into macro-moments`
  );

  const formattedMoments = microMoments
    .map(
      (moment, index) =>
        `## Micro-Moment ${index + 1}\nTitle: ${moment.title}\nContent:\n${
          moment.content
        }\n`
    )
    .join("\n---\n\n");

  const synthesisPrompt = `You are analyzing a development conversation that has been broken down into ${microMoments.length} micro-moments (individual exchanges). Your task is to identify which moments actually matter for understanding the narrative and consolidate related moments into higher-level "macro-moments."

Analyze the micro-moments below and:
1. Identify which micro-moments are important milestones or turning points in the conversation
2. Group related micro-moments together into macro-moments
3. Filter out noise or redundant exchanges that don't add to the narrative
4. For each macro-moment, generate:
   - A concise title (past-tense event, e.g., "User login bug was fixed")
   - A detailed summary (2-4 sentences) that explains WHAT happened, WHY it happened, and HOW it was addressed
   - The consolidated raw content from all micro-moments in this group

Return your response as a JSON array of objects with this exact structure:
[
  {
    "title": "Past-tense event title",
    "summary": "Detailed explanation of what happened, why it happened, and how it was addressed",
    "content": "Consolidated raw content from all micro-moments in this group"
  }
]

Micro-Moments:
${formattedMoments}

Return only valid JSON, no other text.`;

  try {
    const response = await callLLM(synthesisPrompt, "gpt-oss-20b");
    console.log(
      `[cursor-plugin] LLM synthesis response length: ${response.length}`
    );

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error(
        `[cursor-plugin] Failed to extract JSON from LLM response. Response: ${response.substring(
          0,
          500
        )}`
      );
      return microMoments;
    }

    const parsed = JSON.parse(jsonMatch[0]) as SynthesizedMoment[];

    if (!Array.isArray(parsed)) {
      console.error(
        `[cursor-plugin] LLM response is not an array. Got: ${typeof parsed}`
      );
      return microMoments;
    }

    const macroMoments: MomentDescription[] = parsed.map((item) => {
      const rawContent = item.content.trim();
      const synthesizedSummary = item.summary.trim();

      return {
        title: item.title.trim(),
        content: `${rawContent}\n\n---SYNTHESIZED_SUMMARY---\n${synthesizedSummary}`,
        author: microMoments[0]?.author || "cursor-user",
        createdAt: microMoments[0]?.createdAt || new Date().toISOString(),
        sourceMetadata: microMoments[0]?.sourceMetadata,
      };
    });

    console.log(
      `[cursor-plugin] Successfully synthesized ${macroMoments.length} macro-moments`
    );
    return macroMoments;
  } catch (error) {
    console.error(
      `[cursor-plugin] Error during synthesis:`,
      error instanceof Error ? error.message : String(error)
    );
    console.error(
      `[cursor-plugin] Falling back to micro-moments as-is. Error:`,
      error
    );
    return microMoments;
  }
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

      // Fetch cached exchanges for this document
      const cachedExchanges = await getExchangeCache(document.id);
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

      // Write new cache entries
      if (newCacheEntries.length > 0) {
        await setExchangeCache(document.id, newCacheEntries);
        console.log(
          `[cursor-plugin] Cached ${newCacheEntries.length} new exchanges`
        );
      }

      // Update structure hash
      await setDocumentStructureHash(document.id, structureHash);

      if (exchanges.length === 0) {
        return null;
      }

      // Phase 1: Create micro-moments (one per exchange)
      console.log(
        `[cursor-plugin] Phase 1: Creating ${exchanges.length} micro-moments from exchanges`
      );
      const microMoments: MomentDescription[] = exchanges.map(
        (exchange, index) => ({
          title: `Exchange ${index + 1}`,
          content: exchange.content,
          author: exchange.author,
          createdAt: exchange.createdAt,
          sourceMetadata: document.metadata.sourceMetadata,
        })
      );

      console.log(
        `[cursor-plugin] Created ${microMoments.length} micro-moments. Starting Phase 2: Synthesis.`
      );

      // Phase 2: Synthesize micro-moments into macro-moments
      const macroMoments = await synthesizeMoments(microMoments, context);

      console.log(
        `[cursor-plugin] Completed synthesis: ${macroMoments.length} macro-moments from ${microMoments.length} micro-moments`
      );
      return macroMoments.length > 0 ? macroMoments : null;
    },

    async summarizeMomentContent(
      content: string,
      context: IndexingHookContext
    ): Promise<string> {
      const summaryMarker = "---SYNTHESIZED_SUMMARY---\n";
      const summaryIndex = content.indexOf(summaryMarker);

      if (summaryIndex !== -1) {
        const synthesizedSummary = content
          .substring(summaryIndex + summaryMarker.length)
          .trim();
        console.log(
          `[cursor-plugin] Using synthesized summary from LLM synthesis`
        );
        return synthesizedSummary;
      }

      const rawContent =
        summaryIndex !== -1
          ? content.substring(0, summaryIndex).trim()
          : content;

      const summaryPrompt = `Summarize the following content in 2-4 sentences, explaining what happened, why it happened, and how it was addressed:\n\n${rawContent}`;

      try {
        const summary = await callLLM(summaryPrompt, "gpt-oss-20b-cheap");
        return summary.trim();
      } catch (error) {
        console.error(`[cursor-plugin] Failed to generate summary:`, error);
        return `Content about: ${rawContent.substring(0, 100)}...`;
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
