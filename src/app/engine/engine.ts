import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  EngineContext,
  ReconstructedContext,
} from "./types";

export async function indexDocument(
  r2Key: string,
  context: EngineContext
): Promise<Chunk[]> {
  const totalStart = Date.now();
  console.log(`[engine] Starting indexDocument for: ${r2Key}`);
  const indexingContext: IndexingHookContext = {
    r2Key,
    env: context.env,
  };

  const step1Start = Date.now();
  const document = await runFirstMatchHook(
    context.plugins,
    "prepareSourceDocument",
    (plugin) => plugin.prepareSourceDocument?.(indexingContext)
  );
  console.log(
    `[engine] prepareSourceDocument took ${Date.now() - step1Start}ms`
  );

  if (!document) {
    throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
  }

  console.log(
    `[engine] Document prepared: ${document.metadata.title || r2Key}`
  );

  // Try each plugin until we get non-empty chunks
  // Empty arrays are treated as "no match" to allow the correct plugin to handle it
  let chunks: Chunk[] | null = null;
  const step2Start = Date.now();
  for (const plugin of context.plugins) {
    if (plugin.splitDocumentIntoChunks) {
      const result = await plugin.splitDocumentIntoChunks(
        document,
        indexingContext
      );
      // Treat empty arrays as "no match" - continue to next plugin
      if (result && result.length > 0) {
        chunks = result;
        break;
      }
    }
  }
  console.log(
    `[engine] splitDocumentIntoChunks took ${Date.now() - step2Start}ms`
  );

  if (!chunks || chunks.length === 0) {
    throw new Error(`No plugin could split document into chunks: ${r2Key}`);
  }

  console.log(`[engine] Document split into ${chunks.length} chunks`);

  const step3Start = Date.now();
  const enrichedChunks: Chunk[] = [];
  for (const chunk of chunks) {
    let enrichedChunk = chunk;
    for (const plugin of context.plugins) {
      if (plugin.enrichChunk) {
        const result = await plugin.enrichChunk(enrichedChunk, indexingContext);
        if (result) {
          enrichedChunk = result;
        }
      }
    }
    enrichedChunks.push(enrichedChunk);
  }
  console.log(
    `[engine] enrichChunks (all chunks) took ${Date.now() - step3Start}ms`
  );

  console.log(`[engine] indexDocument total took ${Date.now() - totalStart}ms`);
  return enrichedChunks;
}

export async function query(
  userQuery: string,
  context: EngineContext
): Promise<string> {
  const totalStart = Date.now();
  const queryContext: QueryHookContext = {
    query: userQuery,
    env: context.env,
  };

  console.log(`[query] Preparing search query...`);
  const step1Start = Date.now();
  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) => plugin.prepareSearchQuery?.(query, queryContext)
  );
  console.log(
    `[query] Search query preparation took ${Date.now() - step1Start}ms`
  );

  console.log(`[query] Building vector search filter...`);
  const step2Start = Date.now();
  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.buildVectorSearchFilter?.(queryContext)
  );
  console.log(
    `[query] Vector search filter build took ${Date.now() - step2Start}ms`
  );

  console.log(`[query] Performing vector search...`);
  const step3Start = Date.now();
  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses,
    context.env
  );
  console.log(
    `[query] Vector search execution took ${Date.now() - step3Start}ms`
  );
  console.log(`[query] Found ${searchResults.length} search results`);

  if (searchResults.length > 0) {
    console.log(
      `[query] All search results with scores: ${JSON.stringify(
        searchResults.map((r, idx) => ({
          rank: idx + 1,
          documentId: r.documentId,
          chunkId: r.chunkId,
          source: r.source,
          score: (r as any).score,
        }))
      )}`
    );
    console.log(
      `[query] Top 3 search results: ${JSON.stringify(
        searchResults.slice(0, 3).map((r) => ({
          documentId: r.documentId,
          chunkId: r.chunkId,
          source: r.source,
          score: (r as any).score,
        }))
      )}`
    );
  }

  console.log(`[query] Reranking results...`);
  const step4Start = Date.now();
  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) => plugin.rerankSearchResults?.(results, queryContext)
  );
  console.log(`[query] Result reranking took ${Date.now() - step4Start}ms`);

  console.log(`[query] Reconstructing contexts...`);
  const step5Start = Date.now();
  const reconstructedContexts = await reconstructContexts(
    rerankedResults,
    context.plugins,
    queryContext
  );
  console.log(
    `[query] Context reconstruction took ${Date.now() - step5Start}ms`
  );
  console.log(`[query] Reconstructed ${reconstructedContexts.length} contexts`);

  console.log(`[query] Optimizing contexts...`);
  const step55Start = Date.now();
  const optimizedContexts = await runWaterfallHook(
    context.plugins,
    "optimizeContext",
    reconstructedContexts,
    (contexts, plugin) =>
      plugin.optimizeContext?.(contexts, processedQuery, queryContext)
  );
  console.log(
    `[query] Context optimization took ${Date.now() - step55Start}ms`
  );
  console.log(`[query] Optimized to ${optimizedContexts.length} contexts`);

  console.log(`[query] Composing LLM prompt...`);
  const step6Start = Date.now();
  const prompt = await runFirstMatchHook(
    [...context.plugins].reverse(),
    "composeLlmPrompt",
    (plugin) =>
      plugin.composeLlmPrompt?.(optimizedContexts, processedQuery, queryContext)
  );
  console.log(
    `[query] LLM prompt composition took ${Date.now() - step6Start}ms`
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  console.log(`[query] Calling LLM (prompt length: ${prompt.length} chars)...`);

  const step7Start = Date.now();
  const llmResponse = await callLlm(prompt, context.env);
  console.log(`[query] LLM generation took ${Date.now() - step7Start}ms`);
  console.log(
    `[query] LLM response received (length: ${llmResponse.length} chars)`
  );

  console.log(`[query] Formatting final response...`);
  const step9Start = Date.now();
  const formattedResponse = await runWaterfallHook(
    context.plugins,
    "formatFinalResponse",
    llmResponse,
    (response, plugin) =>
      plugin.formatFinalResponse?.(response, rerankedResults, queryContext)
  );
  console.log(
    `[query] Final response formatting took ${Date.now() - step9Start}ms`
  );

  console.log(`[query] Total query time took ${Date.now() - totalStart}ms`);
  return formattedResponse;
}

async function reconstructContexts(
  chunks: ChunkMetadata[],
  plugins: Plugin[],
  queryContext: QueryHookContext
): Promise<ReconstructedContext[]> {
  const start = Date.now();
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
  const fetchStart = Date.now();

  const fetchPromises = Array.from(chunksByDocument.entries()).map(
    async ([documentId, documentChunks]) => {
      const r2Start = Date.now();
      const object = await bucket.get(documentId);
      const fetchTime = Date.now() - r2Start;
      console.log(`[query] R2 fetch for ${documentId} took ${fetchTime}ms`);
      return { documentId, documentChunks, object, fetchTime };
    }
  );

  const fetchResults = await Promise.all(fetchPromises);
  console.log(
    `[query] All R2 fetches completed in ${Date.now() - fetchStart}ms (${
      fetchResults.length
    } documents)`
  );

  const reconstructedContexts: ReconstructedContext[] = [];

  for (const { documentId, documentChunks, object } of fetchResults) {
    if (!object) {
      continue;
    }

    const jsonText = await object.text();
    let sourceDocument: any;
    try {
      sourceDocument = JSON.parse(jsonText);
    } catch (error) {
      // JSON parsing failed (e.g., for JSONL files), pass the raw text to plugins
      // Plugins can handle non-JSON formats themselves
      sourceDocument = jsonText;
    }

    const pluginStart = Date.now();
    const reconstructed = await runFirstMatchHook(
      plugins,
      "reconstructContext",
      (plugin) =>
        plugin.reconstructContext?.(
          documentChunks,
          sourceDocument,
          queryContext
        )
    );
    console.log(
      `[query] reconstructContext hook for ${documentId} took ${
        Date.now() - pluginStart
      }ms`
    );

    if (reconstructed) {
      reconstructedContexts.push(reconstructed);
    }
  }

  console.log(`[query] reconstructContexts total took ${Date.now() - start}ms`);
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
  filterClauses: Record<string, unknown>[],
  env: Cloudflare.Env
): Promise<ChunkMetadata[]> {
  const embedStart = Date.now();
  const embedding = await generateEmbedding(query, env);
  console.log(`[query] Embedding generation took ${Date.now() - embedStart}ms`);

  const combinedFilter = combineFilterClauses(
    filterClauses as Record<string, unknown>[]
  );

  console.log(`[query] Vector search filter:`, JSON.stringify(combinedFilter));
  const vecStart = Date.now();
  const vectorizeResponse = await env.VECTORIZE_INDEX.query(embedding, {
    topK: 50,
    returnMetadata: true,
    filter: combinedFilter as any,
  });
  console.log(`[query] Vectorize query took ${Date.now() - vecStart}ms`);

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

async function generateEmbedding(
  text: string,
  env: Cloudflare.Env
): Promise<number[]> {
  const start = Date.now();
  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as { data: number[][] };
  console.log(`[query] AI.run(embedding) took ${Date.now() - start}ms`);

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error("Failed to generate embedding");
  }

  return response.data[0];
}

async function callLlm(prompt: string, env: Cloudflare.Env): Promise<string> {
  const start = Date.now();
  const response = (await (env.AI.run as any)("@cf/google/gemma-3-12b-it", {
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  })) as { response: string };
  console.log(`[query] AI.run(llm) took ${Date.now() - start}ms`);

  if (!response || typeof response.response !== "string") {
    throw new Error("Failed to get LLM response");
  }

  return response.response;
}
