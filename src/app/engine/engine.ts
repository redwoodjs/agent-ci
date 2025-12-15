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
  MacroMomentDescription,
} from "./types";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import {
  addMoment,
  findSimilarMoments,
  findAncestors,
  upsertMicroMoment,
  getMicroMomentsForDocument,
  findMomentByMicroPathsHash,
  type MicroMoment,
} from "./momentDb";
import { env } from "cloudflare:workers";
import { callLLM } from "./utils/llm";
import { getEmbedding, getEmbeddings } from "./utils/vector";
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

async function hashStrings(values: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(values.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function chunkChunksForMicroComputation(
  chunks: Chunk[],
  opts: { maxBatchChars: number; maxChunkChars: number; maxBatchItems: number }
): Chunk[][] {
  const maxBatchChars =
    Number.isFinite(opts.maxBatchChars) && opts.maxBatchChars > 0
      ? opts.maxBatchChars
      : 10_000;
  const maxChunkChars =
    Number.isFinite(opts.maxChunkChars) && opts.maxChunkChars > 0
      ? opts.maxChunkChars
      : 2_000;
  const maxBatchItems =
    Number.isFinite(opts.maxBatchItems) && opts.maxBatchItems > 0
      ? opts.maxBatchItems
      : 10;

  const out: Chunk[][] = [];
  let currentBatch: Chunk[] = [];
  let currentChars = 0;

  function flush() {
    if (currentBatch.length > 0) {
      out.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
  }

  for (const chunk of chunks) {
    const content = truncateToChars(chunk.content ?? "", maxChunkChars);
    const projectedChars = currentChars + content.length;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchItems || projectedChars > maxBatchChars)
    ) {
      flush();
    }

    currentBatch.push({
      ...chunk,
      content,
    });
    currentChars += content.length;

    if (currentBatch.length >= maxBatchItems || currentChars > maxBatchChars) {
      flush();
    }
  }

  flush();
  return out;
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

  // 3. Compute and cache micro-moments from chunk batches, then synthesize into macro-moments
  // Subjects are now created automatically from root moments via the Moment Graph system.
  // Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects.
  const existingMicroMoments = await getMicroMomentsForDocument(document.id);

  const chunkBatchSizeRaw = (indexingContext.env as any)
    .MICRO_MOMENT_CHUNK_BATCH_SIZE;
  const chunkBatchMaxCharsRaw = (indexingContext.env as any)
    .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
  const chunkMaxCharsRaw = (indexingContext.env as any)
    .MICRO_MOMENT_CHUNK_MAX_CHARS;

  const chunkBatchSize =
    typeof chunkBatchSizeRaw === "string"
      ? Number.parseInt(chunkBatchSizeRaw, 10)
      : typeof chunkBatchSizeRaw === "number"
      ? chunkBatchSizeRaw
      : 10;
  const chunkBatchMaxChars =
    typeof chunkBatchMaxCharsRaw === "string"
      ? Number.parseInt(chunkBatchMaxCharsRaw, 10)
      : typeof chunkBatchMaxCharsRaw === "number"
      ? chunkBatchMaxCharsRaw
      : 10_000;
  const chunkMaxChars =
    typeof chunkMaxCharsRaw === "string"
      ? Number.parseInt(chunkMaxCharsRaw, 10)
      : typeof chunkMaxCharsRaw === "number"
      ? chunkMaxCharsRaw
      : 2_000;

  const chunkBatches = chunkChunksForMicroComputation(chunks, {
    maxBatchChars: chunkBatchMaxChars,
    maxChunkChars: chunkMaxChars,
    maxBatchItems: chunkBatchSize,
  });

  console.log("[moment-linker] micro chunks extracted", {
    documentId: document.id,
    chunks: chunks.length,
    batches: chunkBatches.length,
  });

  const microMomentsForSynthesis: MicroMoment[] = [];

  for (let batchIndex = 0; batchIndex < chunkBatches.length; batchIndex++) {
    const batchChunks = chunkBatches[batchIndex] ?? [];
    const batchKeyParts = batchChunks.map((c) => {
      const hash = c.contentHash ?? "";
      return `${c.id}:${hash}`;
    });
    const batchHash = await hashStrings(batchKeyParts);
    const prefix = `chunk-batch:${batchHash}:`;

    const existingBatchItems = existingMicroMoments
      .filter((m) => m.path.startsWith(prefix))
      .map((m) => {
        const idxStr = m.path.slice(prefix.length);
        const idx = Number.parseInt(idxStr, 10);
        return { idx, m };
      })
      .filter((x) => Number.isFinite(x.idx) && x.idx > 0)
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.m);

    const hasFullCachedBatch =
      existingBatchItems.length > 0 &&
      existingBatchItems.every((m) => !!m.summary && !!m.embedding);

    if (hasFullCachedBatch) {
      microMomentsForSynthesis.push(...existingBatchItems);
      continue;
    }

    const computed = await runFirstMatchHook(
      context.plugins,
      "computeMicroMomentsForChunkBatch",
      (plugin) =>
        plugin.subjects?.computeMicroMomentsForChunkBatch?.(
          batchChunks,
          indexingContext
        )
    );

    const computedItems =
      computed && Array.isArray(computed) ? computed.filter(Boolean) : [];

    const itemsToStore =
      computedItems.length > 0
        ? computedItems
        : batchChunks
            .map((c) => c.content?.trim() ?? "")
            .filter(Boolean)
            .slice(0, 1)
            .map((c) => c.substring(0, 300));

    const embeddings = await getEmbeddings(itemsToStore);

    for (let i = 0; i < itemsToStore.length; i++) {
      const text = itemsToStore[i] ?? "";
      const embedding = embeddings[i] ?? (await getEmbedding(text));
      const path = `${prefix}${i + 1}`;

      await upsertMicroMoment(
        {
          path,
          content: text,
          author: document.metadata.author,
          createdAt: document.metadata.createdAt,
          sourceMetadata: {
            chunkBatchHash: batchHash,
            chunkIds: batchChunks.map((c) => c.id),
          },
        },
        document.id,
        text,
        embedding
      );

      microMomentsForSynthesis.push({
        id: crypto.randomUUID(),
        documentId: document.id,
        path,
        content: text,
        summary: text,
        embedding: embedding,
        createdAt: document.metadata.createdAt,
        author: document.metadata.author,
        sourceMetadata: {
          chunkBatchHash: batchHash,
          chunkIds: batchChunks.map((c) => c.id),
        },
      });
    }
  }

  if (microMomentsForSynthesis.length > 0) {
    console.log("[moment-linker] micro moments loaded", {
      documentId: document.id,
      count: microMomentsForSynthesis.length,
    });

    const macroMomentDescriptions = (await synthesizeMicroMoments(
      microMomentsForSynthesis
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
          microPaths.length > 0 ? await hashMicroPaths(microPaths) : undefined;
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
          summary: description.summary || description.content.substring(0, 200),
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
    const {
      findSimilarSubjects,
      findSimilarMoments,
      findAncestors,
      findDescendants,
    } = await import("./momentDb");

    const similarMoments = await findSimilarMoments(queryEmbedding, 8);
    if (similarMoments.length > 0) {
      const trailsByRoot = new Map<
        string,
        {
          root: unknown;
          trails: unknown[][];
        }
      >();

      for (const matchedMoment of similarMoments) {
        const ancestors = await findAncestors(matchedMoment.id);
        if (ancestors.length === 0) {
          continue;
        }
        const root = ancestors[0];
        const existing = trailsByRoot.get(root.id);
        if (existing) {
          existing.trails.push(ancestors);
        } else {
          trailsByRoot.set(root.id, { root, trails: [ancestors] });
        }
      }

      if (trailsByRoot.size > 0) {
        const rootsSorted = Array.from(trailsByRoot.values()).sort(
          (a, b) => b.trails.length - a.trails.length
        );
        const topRoots = rootsSorted.slice(0, 3);

        const trailsContext = topRoots
          .map((entry, rootIdx) => {
            const root = entry.root as any;
            const trailsText = entry.trails
              .slice(0, 6)
              .map((trail, trailIdx) => {
                const steps = (trail as any[])
                  .map(
                    (m, idx: number) => `${idx + 1}. ${m.title}: ${m.summary}`
                  )
                  .join("\n");
                return `Trail ${trailIdx + 1}\n${steps}`;
              })
              .join("\n\n");

            return `Root ${rootIdx + 1}\n${root.title}: ${
              root.summary
            }\n\n${trailsText}`;
          })
          .join("\n\n---\n\n");

        const narrativePrompt = `Based on the following matched moment trails and their root moments, answer the user's question. Each trail is a chain of moments from a root moment down to a matched moment. Use the trails to explain what happened leading up to the relevant points.

## Matched Trails
${trailsContext}

## User Question
${userQuery}

## Instructions
Provide a clear narrative answer. Prefer causal links and chronological explanation using the trail steps. If multiple roots are present, pick the most relevant one(s) and say why.`;

        const narrativeAnswer = await callLLM(narrativePrompt);
        return narrativeAnswer;
      }
    }

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
