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
  console.log(`[engine] Starting indexDocument for: ${r2Key}`);
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

  console.log(
    `[engine] Document prepared: ${document.metadata.title || r2Key}`
  );

  // Try each plugin until we get non-empty chunks
  // Empty arrays are treated as "no match" to allow the correct plugin to handle it
  let chunks: Chunk[] | null = null;
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

  if (!chunks || chunks.length === 0) {
    throw new Error(`No plugin could split document into chunks: ${r2Key}`);
  }

  console.log(`[engine] Document split into ${chunks.length} chunks`);

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

  console.log(`[query] Step 1: Preparing search query`);
  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) => plugin.prepareSearchQuery?.(query, queryContext)
  );

  console.log(`[query] Step 2: Building vector search filter`);
  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.buildVectorSearchFilter?.(queryContext)
  );

  console.log(`[query] Step 3: Performing vector search`);
  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses,
    context.env
  );
  console.log(`[query] Found ${searchResults.length} search results`);

  console.log(`[query] Step 4: Reranking results`);
  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) => plugin.rerankSearchResults?.(results, queryContext)
  );

  console.log(`[query] Step 5: Reconstructing contexts`);
  const reconstructedContexts = await reconstructContexts(
    rerankedResults,
    context.plugins,
    queryContext
  );
  console.log(`[query] Reconstructed ${reconstructedContexts.length} contexts`);

  console.log(`[query] Step 6: Composing LLM prompt`);

  const prompt = await runFirstMatchHook(
    [...context.plugins].reverse(),
    "composeLlmPrompt",
    (plugin) =>
      plugin.composeLlmPrompt?.(
        reconstructedContexts,
        processedQuery,
        queryContext
      )
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  console.log(
    `[query] Step 7: Calling LLM (prompt length: ${prompt.length} chars)`
  );

  const llmResponse = await callLlm(prompt, context.env);
  console.log(
    `[query] Step 8: LLM response received (length: ${llmResponse.length} chars)`
  );

  console.log(`[query] Step 9: Formatting final response`);
  const formattedResponse = await runWaterfallHook(
    context.plugins,
    "formatFinalResponse",
    llmResponse,
    (response, plugin) =>
      plugin.formatFinalResponse?.(response, rerankedResults, queryContext)
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

  const reconstructedContexts: ReconstructedContext[] = [];

  for (const [documentId, documentChunks] of chunksByDocument) {
    const bucket = queryContext.env.MACHINEN_BUCKET;
    const object = await bucket.get(documentId);
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
  filterClauses: Record<string, unknown>[],
  env: Cloudflare.Env
): Promise<ChunkMetadata[]> {
  const embedding = await generateEmbedding(query, env);

  const combinedFilter = combineFilterClauses(
    filterClauses as Record<string, unknown>[]
  );

  const vectorizeResponse = await env.VECTORIZE_INDEX.query(embedding, {
    topK: 10,
    returnMetadata: true,
    filter: combinedFilter as any,
  });

  return vectorizeResponse.matches.map((match) => {
    if (!match.metadata) {
      throw new Error("Vectorize match missing metadata");
    }
    return match.metadata as ChunkMetadata;
  });
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

async function callLlm(prompt: string, env: Cloudflare.Env): Promise<string> {
  const response = (await (env.AI.run as any)("@cf/google/gemma-3-12b-it", {
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  })) as { response: string };

  if (!response || typeof response.response !== "string") {
    throw new Error("Failed to get LLM response");
  }

  return response.response;
}
