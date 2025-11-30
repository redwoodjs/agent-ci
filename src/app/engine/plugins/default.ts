import type { Plugin, ReconstructedContext, QueryHookContext } from "../types";
import {
  estimateTokens,
  createTokenBudget,
  getAvailableInputTokens,
} from "../utils/token-counter";
import {
  Chunk,
  Document,
  Plugin,
  ReconstructedContext,
  SubjectSearchContext,
} from "../types";

export const defaultPlugin: Plugin = {
  name: "default",

  async findSubjectForText(
    context: SubjectSearchContext
  ): Promise<string | null> {
    const { text, env } = context;
    const { data: embedding } = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [text],
    });

    const vectors = embedding[0];

    const searchResults = await env.SUBJECT_INDEX.query(vectors, {
      topK: 1,
      returnMetadata: true,
    });

    if (searchResults.matches.length > 0) {
      const topMatch = searchResults.matches[0];
      if (topMatch.score > 0.8) {
        // We have a confident match
        return topMatch.id;
      }
    }

    return null;
  },

  async splitDocumentIntoChunks(document: Document): Promise<Chunk[]> {
    // This is a naive chunking strategy that just splits by newline.
    // In a real-world scenario, you'd want a more sophisticated strategy.
    const chunks: Chunk[] = [];
    const lines = document.content.split("\n");
    let currentChunk: string[] = [];

    for (const line of lines) {
      if (currentChunk.length + line.length + 1 > document.chunkSize) {
        chunks.push({
          id: `${document.id}-${chunks.length}`,
          documentId: document.id,
          content: currentChunk.join("\n"),
          metadata: document.metadata,
        });
        currentChunk = [];
      }
      currentChunk.push(line);
    }

    if (currentChunk.length > 0) {
      chunks.push({
        id: `${document.id}-${chunks.length}`,
        documentId: document.id,
        content: currentChunk.join("\n"),
        metadata: document.metadata,
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
};
