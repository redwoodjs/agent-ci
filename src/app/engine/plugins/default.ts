import type { Plugin, ReconstructedContext, QueryHookContext } from "../types";
import {
  estimateTokens,
  createTokenBudget,
  getAvailableInputTokens,
} from "../utils/token-counter";

export const defaultPlugin: Plugin = {
  name: "default",

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
