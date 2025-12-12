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
  MicroMomentDescription,
  MacroMomentDescription,
} from "./types";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import {
  addMoment,
  findSimilarMoments,
  findAncestors,
  getMicroMoment,
  upsertMicroMoment,
  getMicroMomentsForDocument,
  findMomentByMicroPathsHash,
} from "./momentDb";
import { env } from "cloudflare:workers";
import { callLLM } from "./utils/llm";
import { getEmbedding } from "./utils/vector";
import { synthesizeMicroMoments } from "./synthesis/synthesizeMicroMoments";

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

async function hashMicroPaths(microPaths: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(microPaths.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function indexDocument(
  r2Key: string,
  context: EngineContext
): Promise<Chunk[]> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env: context.env,
  };
  console.log("[moment-linker] indexDocument start", { r2Key });

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
    console.log("[moment-linker] skipping: no new chunks", { r2Key });
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
    console.log("[moment-linker] micro moments extracted", {
      documentId: document.id,
      count: microMomentDescriptions.length,
    });
    // Process each micro-moment: check cache, generate summary/embedding if needed
    for (let i = 0; i < microMomentDescriptions.length; i++) {
      const microMomentDesc = microMomentDescriptions[i];
      if (!microMomentDesc) {
        continue;
      }

      // Check cache
      const cached = await getMicroMoment(document.id, microMomentDesc.path);
      if (cached && cached.summary && cached.embedding) {
        console.log("[moment-linker] micro cache hit", {
          documentId: document.id,
          path: microMomentDesc.path,
        });
        continue;
      }
      console.log("[moment-linker] micro cache miss", {
        documentId: document.id,
        path: microMomentDesc.path,
      });

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
      console.log("[moment-linker] micro moments loaded", {
        documentId: document.id,
        count: allMicroMoments.length,
      });
      // Synthesize micro-moments into macro-moments
      const macroMomentDescriptions = (await synthesizeMicroMoments(
        allMicroMoments
      )) as MacroMomentDescription[];

      if (macroMomentDescriptions.length > 0) {
        console.log("[moment-linker] macro moments synthesized", {
          documentId: document.id,
          count: macroMomentDescriptions.length,
          firstTitle: macroMomentDescriptions[0]?.title,
        });
        let resolvedParentIdForFirst: string | undefined = undefined;
        let previousMomentId: string | undefined = undefined;

        for (let i = 0; i < macroMomentDescriptions.length; i++) {
          const description = macroMomentDescriptions[i];
          if (!description) {
            continue;
          }

          const microPaths = description.microPaths || [];
          const microPathsHash =
            microPaths.length > 0
              ? await hashMicroPaths(microPaths)
              : undefined;
          const existing =
            microPathsHash !== undefined
              ? await findMomentByMicroPathsHash(document.id, microPathsHash)
              : null;

          const momentId = existing?.id ?? crypto.randomUUID();
          if (i === 0) {
            if (existing?.parentId) {
              resolvedParentIdForFirst = existing.parentId;
              console.log("[moment-linker] attachment reuse existing parent", {
                documentId: document.id,
                macroMomentIndex: i,
                parentId: resolvedParentIdForFirst,
                momentId,
              });
            } else {
              const parentProposal = await runFirstMatchHook(
                context.plugins,
                "proposeMacroMomentParent",
                (plugin) =>
                  plugin.subjects?.proposeMacroMomentParent?.(
                    document,
                    description,
                    i,
                    indexingContext
                  )
              );
              resolvedParentIdForFirst = parentProposal?.parentMomentId;
              if (parentProposal) {
                console.log("[moment-linker] attachment proposal", {
                  documentId: document.id,
                  macroMomentIndex: i,
                  parentMomentId: parentProposal.parentMomentId,
                  matchedSubjectId: parentProposal.matchedSubjectId,
                  score: parentProposal.score,
                });
              } else {
                console.log("[moment-linker] no attachment proposal", {
                  documentId: document.id,
                  macroMomentIndex: i,
                });
              }
            }
          }
          console.log("[moment-linker] macro correlation", {
            documentId: document.id,
            index: i,
            title: description.title,
            microPathsCount: microPaths.length,
            microPathsHash,
            reuseExisting: Boolean(existing),
            momentId,
            parentId:
              i === 0
                ? resolvedParentIdForFirst ?? null
                : previousMomentId ?? null,
          });
          const moment: Moment = {
            id: momentId,
            documentId: document.id,
            summary:
              description.summary || description.content.substring(0, 200),
            title: description.title,
            parentId: i === 0 ? resolvedParentIdForFirst : previousMomentId,
            microPaths,
            microPathsHash,
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
