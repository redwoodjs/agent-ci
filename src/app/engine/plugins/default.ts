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

  async splitDocumentIntoChunks(
    document: Document,
    context: IndexingHookContext
  ): Promise<Chunk[]> {
    // Default chunking: split by newline, capped by a character limit.
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

  subjects: {
    async getMacroSynthesisPromptContext(
      document: Document,
      context: IndexingHookContext
    ): Promise<string | null> {
      const source = String(document.source ?? "unknown");

      const label =
        source === "github"
          ? "[GitHub]"
          : source === "discord"
          ? "[Discord]"
          : source === "cursor"
          ? "[Cursor Conversation]"
          : `[${source}]`;

      const lines: string[] = [];
      lines.push("Formatting:");
      lines.push(`- title_label: ${label}`);
      lines.push(`- summary_descriptor: In ${source},`);
      lines.push(
        `- canonical_token_note: include canonical tokens only if they are provided in this context`
      );
      lines.push("");
      lines.push("Reference context:");
      lines.push(`- entity_hints:`);
      lines.push(`  - This document source is ${source}.`);
      return lines.join("\n");
    },
    async computeMicroMomentsForChunkBatch(
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<string[] | null> {
      if (chunks.length === 0) {
        return [];
      }

      const sources = new Set<string>();
      for (const chunk of chunks) {
        const src = chunk.source ?? (chunk.metadata as any)?.source;
        if (typeof src === "string" && src.trim().length > 0) {
          sources.add(src.trim());
        }
      }
      const primarySource = sources.size === 1 ? Array.from(sources)[0] : null;

      const sourceContext =
        primarySource === "cursor"
          ? `Context: These chunks are from a Cursor AI coding assistant conversation. Each chunk may include User and Assistant turns. Focus on technical details, decisions, errors, file paths, commands, and outcomes.\n`
          : primarySource === "github"
          ? `Context: These chunks are from GitHub (issues, pull requests, comments, commit messages). Focus on concrete changes, decisions, errors, and references like issue numbers, file paths, and code identifiers.\n`
          : primarySource === "discord"
          ? `Context: These chunks are from Discord chat logs. Focus on concrete decisions, actions, errors, and references that could be used to link related work across conversations.\n`
          : `Context: These chunks are from a single document. Focus on concrete details and avoid generic summaries.\n`;

      const chunkText = chunks
        .map((chunk, i) => {
          const content = chunk.content ?? "";
          return `CHUNK ${i + 1}:\n${content}`;
        })
        .join("\n\n---\n\n");

      const prompt =
        `You will be given a small batch of ordered chunks from a single document.\n` +
        sourceContext +
        `Return a list of short summaries of what was discussed or established.\n\n` +
        `Rules:\n` +
        `- Output must be plain text.\n` +
        `- No prose, no markdown, no code fences.\n` +
        `- Output must be lines in this format: S<index>|<summary>\n` +
        `- Indices start at 1 and must be sequential with no gaps.\n` +
        `- Each summary must be 1-3 sentences.\n` +
        `- Each summary must be <= 400 characters.\n` +
        `- Include concrete terms (names, ids, file paths, errors, decisions) when present.\n` +
        `- Do not include phrases like "Content about".\n` +
        `- Do not output meta commentary about summarizing.\n` +
        `- Return between 1 and 12 items.\n\n` +
        `CHUNKS:\n${chunkText}\n\n` +
        `OUTPUT:`;

      try {
        const response = await callLLM(prompt, "slow-reasoning", {
          temperature: 0,
          max_tokens: 1200,
          reasoning: {
            effort: "low",
            summary: "concise",
          },
        });

        const trimmed = response.trim();
        const withoutFences = trimmed
          .replace(/^```[a-z]*\s*/i, "")
          .replace(/\s*```$/, "");

        const matches = Array.from(
          withoutFences.matchAll(/(?:S)?(\d+)\|([^\n]*)/g)
        );
        if (matches.length === 0) {
          return null;
        }

        const byIndex = new Map<number, string>();
        for (const match of matches) {
          const idxStr = match[1] ?? "";
          const body = (match[2] ?? "").trim().replace(/\s+/g, " ");
          if (/^Content about:/i.test(body)) {
            return null;
          }
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
