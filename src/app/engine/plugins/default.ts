import type {
  Plugin,
  ReconstructedContext,
  QueryHookContext,
  SubjectSearchContext,
} from "../types";
import { Chunk, Document, IndexingHookContext } from "../types";
import {
  estimateTokens,
  createTokenBudget,
  getAvailableInputTokens,
} from "../utils/token-counter";
import { SubjectDescription } from "../types";

export const defaultPlugin: Plugin = {
  name: "default",

  subjects: {
    async findSubjectForText(
      context: SubjectSearchContext
    ): Promise<string | null> {
      const { text, env } = context;
      const embeddingResponse = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
        text: [text], // We search using the new chunk's content
      })) as { data: number[][] };

      const vectors = embeddingResponse.data[0];

      const searchResults = await env.SUBJECT_INDEX.query(vectors, {
        topK: 1,
        returnMetadata: true,
      });

      if (searchResults.matches.length > 0) {
        const topMatch = searchResults.matches[0];
        // Increase threshold to require a stronger match, encouraging creation of new subjects.
        if (topMatch.score > 0.85) {
          return topMatch.id;
        }
      }

      return null;
    },
    async generateSubjectTitle(context: SubjectSearchContext): Promise<string> {
      const { text, env } = context;
      const truncatedText = text.substring(0, 1000);
      console.log(
        `[default-plugin] Generating title for text length: ${text.length} (truncated to 1000)`
      );

      try {
        const titlePrompt = `Analyze the following text from a document and generate a short, concise title (less than 10 words) that summarizes its core subject. Examples: "Bug: User login fails", "Feature: Add dark mode", "Refactor: API authentication". Do not include quotes in the title. Text: "${truncatedText}"`;

        const titleResponse = (await env.AI.run(
          "@cf/meta/llama-3-8b-instruct",
          {
            prompt: titlePrompt,
          }
        )) as { response: string };

        if (!titleResponse || !titleResponse.response) {
          console.warn(
            "[default-plugin] AI returned empty response for title generation"
          );
          return "Untitled Subject";
        }

        const newTitle = titleResponse.response.trim().replace(/"/g, "");
        if (!newTitle) {
          console.warn("[default-plugin] AI generated empty title string");
          return "Untitled Subject";
        }

        return newTitle;
      } catch (error) {
        console.error(
          "[default-plugin] Error generating subject title:",
          error
        );
        // Fallback to a safe title so we don't drop the subject
        return "Untitled Subject";
      }
    },
    async determineSubjectsForDocument(
      document: Document,
      chunks: Chunk[],
      context: IndexingHookContext
    ): Promise<SubjectDescription[] | null> {
      // Default behavior: treat the entire document as a single subject.
      // A more specific plugin (e.g., for GitHub) would implement more nuanced logic.
      if (chunks.length === 0) {
        return null;
      }

      // Use a SHA-256 hash of the document ID as the stable content identifier
      const encoder = new TextEncoder();
      const data = encoder.encode(document.id);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const idempotencyKey = hashArray
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const description: SubjectDescription = {
        title: document.metadata.title,
        narrative: document.content, // Use the whole document content as the initial narrative
        idempotency_key: idempotencyKey,
        chunks: chunks, // Associate all chunks with this single subject
      };

      return [description];
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
