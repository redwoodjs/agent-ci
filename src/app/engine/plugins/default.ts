import type { Plugin, ReconstructedContext, QueryHookContext } from "../types";
import { Chunk, Document, IndexingHookContext } from "../types";
import {
  estimateTokens,
  createTokenBudget,
  getAvailableInputTokens,
} from "../utils/token-counter";
import { callLLM } from "../utils/llm";

export const defaultPlugin: Plugin = {
  name: "default",

  subjects: {
    async summarizeMomentContents(
      contents: string[],
      context: IndexingHookContext
    ): Promise<string[]> {
      const itemsJson = JSON.stringify(contents);
      const summaryPrompt =
        `Return a JSON array of concise one-sentence summaries.\n` +
        `- Output must be a JSON array of strings.\n` +
        `- The output array length must equal the input length.\n` +
        `- Summaries must be in the same order as the inputs.\n\n` +
        `INPUTS (JSON array of strings):\n${itemsJson}\n\n` +
        `OUTPUT (JSON array of strings only):`;

      try {
        const summary = await callLLM(summaryPrompt, "quick-cheap");
        const trimmed = summary.trim();
        const withoutFences = trimmed
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/\s*```$/, "");
        const start = withoutFences.indexOf("[");
        const end = withoutFences.lastIndexOf("]");
        const slice =
          start >= 0 && end >= 0 && end > start
            ? withoutFences.slice(start, end + 1)
            : withoutFences;
        const parsed = JSON.parse(slice) as unknown;
        if (!Array.isArray(parsed) || parsed.length !== contents.length) {
          return contents.map((content) =>
            `Content about: ${content.substring(0, 100)}...`.trim()
          );
        }
        return parsed.map((x, i) => {
          if (typeof x === "string") {
            return x.trim();
          }
          const content = contents[i] ?? "";
          return `Content about: ${content.substring(0, 100)}...`.trim();
        });
      } catch (error) {
        console.error(`[default-plugin] Failed to generate summary:`, error);
        return contents.map((content) =>
          `Content about: ${content.substring(0, 100)}...`.trim()
        );
      }
    },
  },

  evidence: {
    async splitDocumentIntoChunks(
      document: Document,
      context: IndexingHookContext
    ): Promise<Chunk[]> {
      // This is a naive chunking strategy that just splits by newline.
      // In a real-world scenario, you'd want a more sophisticated strategy.
      const chunks: Chunk[] = [];
      const lines = document.content.split("\n");
      let currentChunkContent: string[] = [];
      const CHUNK_SIZE = 1000; // characters per chunk

      const encoder = new TextEncoder();
      async function hashContent(content: string): Promise<string> {
        const data = encoder.encode(content);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      }

      for (const line of lines) {
        if (
          currentChunkContent.join("\n").length + line.length + 1 >
          CHUNK_SIZE
        ) {
          const chunkId = `${document.id}-${chunks.length}`;
          const content = currentChunkContent.join("\n");
          chunks.push({
            id: chunkId,
            documentId: document.id,
            source: document.source,
            content: content,
            contentHash: await hashContent(content),
            metadata: {
              chunkId,
              documentId: document.id,
              source: document.source,
              type: document.type,
              documentTitle: document.metadata.title,
              author: document.metadata.author,
              jsonPath: "$.content",
              sourceMetadata: document.metadata.sourceMetadata,
            },
          });
          currentChunkContent = [];
        }
        currentChunkContent.push(line);
      }

      if (currentChunkContent.length > 0) {
        const chunkId = `${document.id}-${chunks.length}`;
        const content = currentChunkContent.join("\n");
        chunks.push({
          id: chunkId,
          documentId: document.id,
          source: document.source,
          content: content,
          contentHash: await hashContent(content),
          metadata: {
            chunkId,
            documentId: document.id,
            source: document.source,
            type: document.type,
            documentTitle: document.metadata.title,
            author: document.metadata.author,
            jsonPath: "$.content",
            sourceMetadata: document.metadata.sourceMetadata,
          },
        });
      }

      return chunks;
    },

    async optimizeContext(
      contexts: ReconstructedContext[],
      query: string,
      context: QueryHookContext
    ): Promise<ReconstructedContext[]> {
      const budget = createTokenBudget();
      const availableTokens = getAvailableInputTokens(budget);

      // Reserve tokens for the prompt structure (instructions, query, etc.)
      const promptOverhead = 1000;
      const queryTokens = estimateTokens(query);
      const effectiveBudget = availableTokens - promptOverhead - queryTokens;

      const optimized: ReconstructedContext[] = [];
      let currentTokens = 0;

      console.log(
        `[optimizeContext] Starting optimization. Budget: ${effectiveBudget} tokens`
      );

      for (const ctx of contexts) {
        const ctxTokens = estimateTokens(ctx.content);

        if (currentTokens + ctxTokens <= effectiveBudget) {
          optimized.push(ctx);
          currentTokens += ctxTokens;
        } else {
          console.log(
            `[optimizeContext] Skipping context from ${ctx.source} (${ctxTokens} tokens) - would exceed budget`
          );
        }
      }

      console.log(
        `[optimizeContext] Selected ${optimized.length}/${contexts.length} contexts. Total tokens: ${currentTokens}`
      );

      return optimized;
    },

    async composeLlmPrompt(
      contexts: ReconstructedContext[],
      query: string,
      context: QueryHookContext
    ): Promise<string> {
      const contextSection = contexts
        .map((ctx) => ctx.content)
        .join("\n\n---\n\n");

      return `You are a helpful assistant that answers questions based on the provided context.

## Context

${contextSection}

## Question

${query}

## Instructions

Based on the context above, please answer the question. If the context doesn't contain enough information to answer the question, say so.`;
    },
  },
};
