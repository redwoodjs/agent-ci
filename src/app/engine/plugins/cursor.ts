import {
  Plugin,
  IndexingHookContext,
  Document,
  Chunk,
  ChunkMetadata,
  QueryHookContext,
  SubjectDescription,
  MomentDescription,
  CursorConversationLatestJson,
} from "../types";
import { generateTitleForText } from "../utils/summarize";
import { callLLM } from "../utils/llm";
import { getEmbedding, cosineSimilarity } from "../utils/vector";

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
    async determineSubjectsForDocument(
      document: Document,
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<SubjectDescription[] | null> {
      if (document.source !== "cursor") {
        return null;
      }
      if (chunks.length === 0) {
        return null;
      }

      const firstChunkContent = chunks[0]?.content;
      if (!firstChunkContent) {
        return null;
      }

      const title = await generateTitleForText(firstChunkContent);

      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(document.id);
      if (!object) {
        throw new Error(`R2 object not found: ${document.id}`);
      }
      const jsonText = await object.text();
      const data = JSON.parse(jsonText) as CursorConversationLatestJson;
      const narrativeComponents = extractUserPrompts(data);

      const encoder = new TextEncoder();
      const dataBytes = encoder.encode(document.id);
      const hashBuffer = await crypto.subtle.digest("SHA-256", dataBytes);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const idempotencyKey = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const description: SubjectDescription = {
        title: title,
        narrativeComponents:
          narrativeComponents.length > 0
            ? narrativeComponents
            : [document.content],
        idempotency_key: idempotencyKey,
        chunks: chunks,
      };

      return [description];
    },
    async extractMomentsFromDocument(
      document: Document,
      context: IndexingHookContext
    ): Promise<MomentDescription[] | null> {
      if (document.source !== "cursor") {
        return null;
      }

      const bucket = context.env.MACHINEN_BUCKET;
      const object = await bucket.get(document.id);
      if (!object) {
        throw new Error(`R2 object not found: ${document.id}`);
      }
      const jsonText = await object.text();
      const data = JSON.parse(jsonText) as CursorConversationLatestJson;

      const exchanges: Exchange[] = [];

      // 1. First Pass: Summarize and embed each exchange
      for (const gen of data.generations) {
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

        if (!userPrompt.trim() && !assistantResponse.trim()) {
          continue;
        }

        let content = "";
        if (userPrompt) content += `User: ${userPrompt}\n`;
        if (assistantResponse) content += `Assistant: ${assistantResponse}`;

        const summary = await callLLM(
          `Summarize this exchange in one sentence: ${content}`,
          "gpt-oss-20b-cheap"
        );
        const embedding = await getEmbedding(summary);

        exchanges.push({
          content: content.trim(),
          summary,
          embedding,
          createdAt: new Date().toISOString(),
          author: "cursor-user",
        });
      }

      if (exchanges.length === 0) {
        return null;
      }

      // 2. Second Pass: Group exchanges by similarity
      const moments: MomentDescription[] = [];
      let currentMomentExchanges: Exchange[] = [exchanges[0]];
      const SIMILARITY_THRESHOLD = 0.9;

      for (let i = 1; i < exchanges.length; i++) {
        const prevEmbedding = exchanges[i - 1].embedding;
        const currentEmbedding = exchanges[i].embedding;
        const similarity = cosineSimilarity(prevEmbedding, currentEmbedding);

        if (similarity >= SIMILARITY_THRESHOLD) {
          currentMomentExchanges.push(exchanges[i]);
        } else {
          // Consolidate the completed moment
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

          // Start a new moment
          currentMomentExchanges = [exchanges[i]];
        }
      }

      // Consolidate the last moment
      if (currentMomentExchanges.length > 0) {
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
      }

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
