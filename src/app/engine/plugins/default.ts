import type { Plugin, ReconstructedContext, QueryHookContext } from "../types";

export const defaultPlugin: Plugin = {
  name: "default",

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
