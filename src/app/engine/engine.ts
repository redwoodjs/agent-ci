import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  EngineContext,
  ReconstructedContext,
  Moment,
  MomentDescription,
  MicroMomentDescription,
} from "./types";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import {
  addMoment,
  findSimilarMoments,
  findAncestors,
  getMicroMoment,
  upsertMicroMoment,
  getMicroMomentsForDocument,
  type MicroMoment,
} from "./momentDb";
import { env } from "cloudflare:workers";
import { callLLM } from "./utils/llm";
import { getEmbedding } from "./utils/vector";

async function hashChunkId(chunkId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(chunkId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.substring(0, 16);
}

interface SynthesizedMoment {
  title: string;
  summary: string;
  content: string;
}

async function synthesizeMicroMoments(
  microMoments: MicroMoment[]
): Promise<Array<MomentDescription & { summary: string }>> {
  if (microMoments.length === 0) {
    return [];
  }

  const formattedMoments = microMoments
    .map(
      (moment) =>
        `Path: ${moment.path}\nSummary: ${moment.summary || "No summary"}\n`
    )
    .join("\n---\n\n");

  const synthesisPrompt = `You are an expert at analyzing sequences of events to build a coherent narrative. Your task is to consolidate a series of low-level "micro-moments" into a smaller number of high-level "macro-moments" that tell a story of progress, discovery, and decision-making.

**Your Goal:** Identify and record the most significant events. Specifically look for turning points, key discoveries or realizations, newly identified problems, new insights, important decisions, changes in approach, new attempts at solving the problem

**Output format (strictly follow this):**

MACRO-MOMENT 1
TITLE: A concise, past-tense title for the event (e.g., "Realized barrel files were needed for tree-shaking")
SUMMARY: 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project.

MACRO-MOMENT 2
TITLE: A concise, past-tense title for the event
SUMMARY: 2-4 sentences explaining what happened, why it was a significant turning point or decision, and what its impact was on the project.

**Input micro-moments:**
${formattedMoments}

**Your response must:**
- Begin with "MACRO-MOMENT 1"
- Contain only the formatted blocks.
- Focus on the story of the work, not just a chronological list.`;

  try {
    const response = await callLLM(synthesisPrompt, "gpt-oss-20b", {
      temperature: 0.3, // Lower temperature for more focused, deterministic reasoning
      max_tokens: 2000, // Allow sufficient space for multiple macro-moments
      reasoning: {
        effort: "low", // Start with low reasoning effort
      },
    });

    // Parse structured text format - extract blocks even if there's extra text
    const macroMoments: Array<MomentDescription & { summary: string }> = [];
    const momentRegex =
      /MACRO-MOMENT \d+\s*TITLE:\s*(.*?)\s*SUMMARY:\s*([\s\S]*?)(?=\s*MACRO-MOMENT \d+|$)/g;

    let match;
    while ((match = momentRegex.exec(response)) !== null) {
      const [, title, summary] = match;
      if (title && summary) {
        // Concatenate all micro-moment content as the macro-moment content
        // (we don't track which micro-moments map to which macro-moment)
        const content = microMoments
          .map((m) => m.content)
          .filter(Boolean)
          .join("\n\n---\n\n");

        macroMoments.push({
          title: title.trim(),
          summary: summary.trim(),
          content: content || "",
          author: microMoments[0]?.author || "unknown",
          createdAt: microMoments[0]?.createdAt || new Date().toISOString(),
          sourceMetadata: microMoments[0]?.sourceMetadata,
        });
      }
    }

    if (macroMoments.length === 0) {
      console.error(
        `[engine] Failed to parse any macro-moments from response. Full response:\n${response}`
      );
      throw new Error(
        `Failed to parse macro-moments from LLM response. Response: ${response.substring(
          0,
          500
        )}`
      );
    }

    return macroMoments;
  } catch (error) {
    console.error(
      `[engine] Error during synthesis:`,
      error instanceof Error ? error.message : String(error)
    );
    return [];
  }
}

export async function indexDocument(
  r2Key: string,
  context: EngineContext
): Promise<Chunk[]> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env: context.env,
  };

  const document = await runFirstMatchHook(
    context.plugins,
    "prepareSourceDocument",
    (plugin) => plugin.prepareSourceDocument?.(indexingContext)
  );

  if (!document) {
    throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
  }

  // 1. Split document into chunks BEFORE subject correlation
  let chunks: Chunk[] | null = null;
  for (const plugin of context.plugins) {
    if (plugin.evidence?.splitDocumentIntoChunks) {
      const result = await plugin.evidence.splitDocumentIntoChunks(
        document,
        indexingContext
      );
      if (result && result.length > 0) {
        chunks = result;
        break;
      }
    }
  }

  if (!chunks || chunks.length === 0) {
    throw new Error(`No plugin could split document into chunks: ${r2Key}`);
  }

  // 2. Diff against previously processed chunks to avoid redundant work
  const oldChunkHashes = await getProcessedChunkHashes(r2Key);
  const oldChunkHashSet = new Set(oldChunkHashes);

  const newChunks = chunks.filter(
    (chunk) => !oldChunkHashSet.has(chunk.contentHash!)
  );

  if (newChunks.length === 0) {
    return []; // Nothing more to do
  }

  // 3. Extract and process micro-moments, then synthesize into macro-moments
  // Subjects are now created automatically from root moments via the Moment Graph system.
  // Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects.
  const microMomentDescriptions = await runFirstMatchHook(
    context.plugins,
    "extractMicroMomentsFromDocument",
    (plugin) =>
      plugin.subjects?.extractMicroMomentsFromDocument?.(
        document,
        indexingContext
      )
  );

  if (microMomentDescriptions && microMomentDescriptions.length > 0) {
    // Process each micro-moment: check cache, generate summary/embedding if needed
    for (let i = 0; i < microMomentDescriptions.length; i++) {
      const microMomentDesc = microMomentDescriptions[i];
      if (!microMomentDesc) {
        continue;
      }

      // Check cache
      const cached = await getMicroMoment(document.id, microMomentDesc.path);
      if (cached && cached.summary && cached.embedding) {
        continue;
      }

      // Cache miss: generate summary and embedding
      const summary = await runFirstMatchHook(
        context.plugins,
        "summarizeMomentContent",
        (plugin) =>
          plugin.subjects?.summarizeMomentContent?.(
            microMomentDesc.content,
            indexingContext
          )
      );

      if (!summary) {
        continue;
      }

      const embedding = await getEmbedding(summary);
      await upsertMicroMoment(microMomentDesc, document.id, summary, embedding);
    }

    // Retrieve all micro-moments for this document (now with summaries/embeddings)
    const allMicroMoments = await getMicroMomentsForDocument(document.id);

    if (allMicroMoments.length > 0) {
      // Synthesize micro-moments into macro-moments
      const macroMomentDescriptions = await synthesizeMicroMoments(
        allMicroMoments
      );

      if (macroMomentDescriptions.length > 0) {
        let previousMomentId: string | undefined = undefined;

        for (let i = 0; i < macroMomentDescriptions.length; i++) {
          const description = macroMomentDescriptions[i];
          if (!description) {
            continue;
          }

          const momentId = crypto.randomUUID();
          const moment: Moment = {
            id: momentId,
            documentId: document.id,
            summary:
              description.summary || description.content.substring(0, 200),
            title: description.title,
            parentId: previousMomentId,
            createdAt: description.createdAt,
            author: description.author,
            sourceMetadata: description.sourceMetadata,
          };

          await addMoment(moment);
          previousMomentId = momentId;
        }
      }
    }
  }

  // 4. Enrich chunks (optional, original logic for the new chunks)
  const enrichedChunks: Chunk[] = [];
  for (const chunk of newChunks) {
    let enrichedChunk = chunk;
    for (const plugin of context.plugins) {
      if (plugin.evidence?.enrichChunk) {
        const result = await plugin.evidence.enrichChunk(
          enrichedChunk,
          indexingContext
        );
        if (result) {
          enrichedChunk = result;
        }
      }
    }
    enrichedChunks.push(enrichedChunk);
  }

  // 5. After successful processing, update the state with the hashes of *all* current chunks
  const allCurrentChunkHashes = chunks.map((c) => c.contentHash!);
  await setProcessedChunkHashes(r2Key, allCurrentChunkHashes);

  return enrichedChunks;
}

export async function query(
  userQuery: string,
  context: EngineContext
): Promise<string> {
  const queryContext: QueryHookContext = {
    query: userQuery,
    env: context.env,
  };

  // Narrative Query Path: Try to answer using Subject (root moment) first
  try {
    const queryEmbedding = await generateEmbedding(userQuery);
    const { findSimilarSubjects, findDescendants } = await import("./momentDb");
    const similarSubjects = await findSimilarSubjects(queryEmbedding, 5);

    if (similarSubjects.length > 0) {
      const subjectMoment = similarSubjects[0];

      // Get the full narrative timeline (root moment + all descendants)
      const timeline = await findDescendants(subjectMoment.id);

      if (timeline.length > 0) {
        // Build narrative context from moment summaries
        const narrativeContext = timeline
          .map(
            (moment, idx) => `${idx + 1}. ${moment.title}: ${moment.summary}`
          )
          .join("\n\n");

        const narrativePrompt = `Based on the following Subject and its timeline of events, answer the user's question. The Subject represents the main topic, and the timeline shows the sequence of related moments in chronological order.

## Subject
${subjectMoment.title}: ${subjectMoment.summary}

## Timeline
${narrativeContext}

## User Question
${userQuery}

## Instructions
Provide a clear, narrative answer that explains the story and causal relationships between events. Focus on answering "why" and "how" questions based on the Subject and the sequence of events in its timeline.`;

        const narrativeAnswer = await callLLM(narrativePrompt);
        return narrativeAnswer;
      }
    }
  } catch (error) {
    console.error(
      `[query:narrative] ✗ Narrative query path failed, falling back to chunk-based RAG:`,
      error
    );
    // Fall through to the existing chunk-based RAG system
  }

  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) =>
      plugin.evidence?.prepareSearchQuery?.(query, queryContext)
  );

  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.evidence?.buildVectorSearchFilter?.(queryContext)
  );

  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses
  );

  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) =>
      plugin.evidence?.rerankSearchResults?.(results, queryContext)
  );

  const reconstructedContexts = await reconstructContexts(
    rerankedResults,
    context.plugins,
    queryContext
  );

  const optimizedContexts = await runWaterfallHook(
    context.plugins,
    "optimizeContext",
    reconstructedContexts,
    (contexts, plugin) =>
      plugin.evidence?.optimizeContext?.(contexts, processedQuery, queryContext)
  );

  const prompt = await runFirstMatchHook(
    [...context.plugins].reverse(),
    "composeLlmPrompt",
    (plugin) =>
      plugin.evidence?.composeLlmPrompt?.(
        optimizedContexts,
        processedQuery,
        queryContext
      )
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  const llmResponse = await callLLM(prompt);

  const formattedResponse = await runWaterfallHook(
    context.plugins,
    "formatFinalResponse",
    llmResponse,
    (response, plugin) =>
      plugin.evidence?.formatFinalResponse?.(
        response,
        rerankedResults,
        queryContext
      )
  );

  return formattedResponse;
}


async function reconstructContexts(
  chunks: ChunkMetadata[],
  plugins: Plugin[],
  queryContext: QueryHookContext
): Promise<ReconstructedContext[]> {
  const chunksByDocument = new Map<string, ChunkMetadata[]>();

  for (const chunk of chunks) {
    if (!chunk.documentId) {
      continue;
    }
    if (!chunksByDocument.has(chunk.documentId)) {
      chunksByDocument.set(chunk.documentId, []);
    }
    chunksByDocument.get(chunk.documentId)!.push(chunk);
  }

  const bucket = queryContext.env.MACHINEN_BUCKET;

  const documentEntries = Array.from(chunksByDocument.entries());
  const CONCURRENT_FETCH_LIMIT = 6;
  const fetchResults: Array<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
  }> = [];

  async function fetchAndReadDocument(
    documentId: string,
    documentChunks: ChunkMetadata[]
  ): Promise<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
  }> {
    const object = await bucket.get(documentId);

    if (!object) {
      return { documentId, documentChunks, sourceDocument: null };
    }

    const jsonText = await object.text();
    let sourceDocument: any;
    try {
      sourceDocument = JSON.parse(jsonText);
    } catch (error) {
      sourceDocument = jsonText;
    }

    return { documentId, documentChunks, sourceDocument };
  }

  const inFlight = new Set<Promise<(typeof fetchResults)[0]>>();
  let nextIndex = 0;

  while (nextIndex < documentEntries.length || inFlight.size > 0) {
    while (
      inFlight.size < CONCURRENT_FETCH_LIMIT &&
      nextIndex < documentEntries.length
    ) {
      const [documentId, documentChunks] = documentEntries[nextIndex++];
      const promise = fetchAndReadDocument(documentId, documentChunks);
      promise.finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }

    if (inFlight.size > 0) {
      const result = await Promise.race(Array.from(inFlight));
      fetchResults.push(result);
    }
  }

  const reconstructedContexts: ReconstructedContext[] = [];

  for (const { documentId, documentChunks, sourceDocument } of fetchResults) {
    if (!sourceDocument) {
      continue;
    }

    const reconstructed = await runFirstMatchHook(
      plugins,
      "reconstructContext",
      (plugin) =>
        plugin.evidence?.reconstructContext?.(
          documentChunks,
          sourceDocument,
          queryContext
        )
    );

    if (reconstructed) {
      reconstructedContexts.push(reconstructed);
    }
  }

  return reconstructedContexts;
}

async function runFirstMatchHook<T>(
  plugins: Plugin[],
  hookName: string,
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T | null> {
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

async function runWaterfallHook<T>(
  plugins: Plugin[],
  hookName: string,
  initialValue: T,
  fn: (value: T, plugin: Plugin) => Promise<T | undefined> | undefined
): Promise<T> {
  let value = initialValue;
  for (const plugin of plugins) {
    const result = await fn(value, plugin);
    if (result !== undefined) {
      value = result;
    }
  }
  return value;
}

async function runCollectorHook<T>(
  plugins: Plugin[],
  hookName: string,
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T[]> {
  const results: T[] = [];
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      results.push(result);
    }
  }
  return results;
}

async function performVectorSearch(
  query: string,
  filterClauses: Record<string, unknown>[]
): Promise<ChunkMetadata[]> {
  const embedding = await generateEmbedding(query);

  const combinedFilter = combineFilterClauses(
    filterClauses as Record<string, unknown>[]
  );

  const vectorizeResponse = await env.VECTORIZE_INDEX.query(embedding, {
    topK: 50,
    returnMetadata: true,
    filter: combinedFilter as any,
  });

  const results = vectorizeResponse.matches.map((match) => {
    if (!match.metadata) {
      throw new Error("Vectorize match missing metadata");
    }
    const metadata = match.metadata as ChunkMetadata;
    (metadata as any).score = match.score;
    return metadata;
  });
  return results;
}

function combineFilterClauses(
  clauses: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  if (clauses.length === 0) {
    return undefined;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return {
    $and: clauses,
  };
}

async function generateEmbedding(text: string): Promise<number[]> {
  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as { data: number[][] };

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error("Failed to generate embedding");
  }

  return response.data[0];
}
