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
import { generateTitleForText } from "../utils/summarize";

export const defaultPlugin: Plugin = {
  name: "default",

  subjects: {
    async findSubjectForText(
      context: SubjectSearchContext
    ): Promise<string | null> {
      try {
        const { text, env } = context;
        const embeddingResponse = (await env.AI.run(
          "@cf/baai/bge-base-en-v1.5",
          {
            text: [text], // We search using the new chunk's content
          }
        )) as { data: number[][] };

        if (!embeddingResponse.data || embeddingResponse.data.length === 0) {
          console.error(
            `[default-plugin:dedup-debug] AI.run for embedding returned no data for text: ${text.substring(
              0,
              100
            )}...`
          );
          return null;
        }

        const vectors = embeddingResponse.data[0];

        console.log(
          `[default-plugin:dedup-debug] Search text (length: ${
            text.length
          }): ${JSON.stringify(text)}`
        );
        console.log(
          `[default-plugin:dedup-debug] Generated embedding (dimension: ${vectors.length})`
        );

        const searchResults = await env.SUBJECT_INDEX.query(vectors, {
          topK: 5, // Increase to see more matches for debugging
          returnMetadata: true,
        });

        console.log(
          `[default-plugin:dedup-debug] Vector search found ${searchResults.matches.length} matches`
        );

        if (searchResults.matches.length > 0) {
          console.log(
            `[default-plugin:dedup-debug] All matches: ${JSON.stringify(
              searchResults.matches.map((m) => ({
                id: m.id,
                score: m.score.toFixed(4),
                title: m.metadata?.title,
              }))
            )}`
          );
        }

        if (searchResults.matches.length > 0) {
          const topMatch = searchResults.matches[0];
          console.log(
            `[default-plugin:dedup-debug] Top match: subjectId=${
              topMatch.id
            }, score=${topMatch.score.toFixed(4)}, threshold=0.85`
          );
          // Increase threshold to require a stronger match, encouraging creation of new subjects.
          if (topMatch.score > 0.85) {
            console.log(
              `[default-plugin:dedup-debug] Match PASSED threshold, returning subjectId: ${topMatch.id}`
            );
            return topMatch.id;
          } else {
            console.log(
              `[default-plugin:dedup-debug] Match FAILED threshold (${topMatch.score.toFixed(
                4
              )} <= 0.85), returning null`
            );
          }
        } else {
          console.log(
            `[default-plugin:dedup-debug] No matches found, returning null`
          );
        }

        return null;
      } catch (error) {
        console.error(
          `[default-plugin:dedup-debug] CRITICAL: Error inside findSubjectForText hook:`,
          error
        );
        return null; // Return null to prevent crashing the whole indexing job
      }
    },
    async generateSubjectTitle(context: SubjectSearchContext): Promise<string> {
      return generateTitleForText(context.text, context.env);
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
