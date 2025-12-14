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
    async computeMicroMomentsForChunkBatch(
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<string[] | null> {
      if (chunks.length === 0) {
        return [];
      }

      const chunkText = chunks
        .map((chunk, i) => {
          const content = chunk.content ?? "";
          return `CHUNK ${i + 1}:\n${content}`;
        })
        .join("\n\n---\n\n");

      const prompt =
        `You will be given a small batch of ordered chunks from a single document.\n` +
        `Return a list of short "what happened" items.\n\n` +
        `Rules:\n` +
        `- Output must be plain text.\n` +
        `- No prose, no markdown, no code fences.\n` +
        `- Output must be lines in this format: S<index>|<one sentence>\n` +
        `- Indices start at 1 and must be sequential with no gaps.\n` +
        `- Each sentence must be <= 200 characters.\n` +
        `- Return between 1 and 12 items.\n\n` +
        `CHUNKS:\n${chunkText}\n\n` +
        `OUTPUT:`;

      try {
        const response = await callLLM(prompt, "quick-cheap", {
          temperature: 0,
          max_tokens: 1200,
        });

        const trimmed = response.trim();
        const withoutFences = trimmed
          .replace(/^```[a-z]*\s*/i, "")
          .replace(/\s*```$/, "");

        const matches = Array.from(withoutFences.matchAll(/S(\d+)\|([^\n]*)/g));
        if (matches.length === 0) {
          return null;
        }

        const byIndex = new Map<number, string>();
        for (const match of matches) {
          const idxStr = match[1] ?? "";
          const body = (match[2] ?? "").trim().replace(/\s+/g, " ");
          const idx = Number.parseInt(idxStr, 10);
          if (!Number.isFinite(idx) || idx < 1) {
            continue;
          }
          if (body) {
            byIndex.set(idx, body);
          }
        }

        const out: string[] = [];
        for (let i = 1; i <= 12; i++) {
          const body = byIndex.get(i);
          if (!body) {
            break;
          }
          out.push(body);
        }

        return out.length > 0 ? out : null;
      } catch (error) {
        console.error(
          `[default-plugin] Failed to compute micro moments from chunk batch:`,
          error
        );
        return null;
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
