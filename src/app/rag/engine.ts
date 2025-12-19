import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  EngineContext,
} from "./types";
import { callLLM } from "../engine/utils/llm";

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

  const chunks = await runFirstMatchHook(
    context.plugins,
    "splitDocumentIntoChunks",
    (plugin) => plugin.splitDocumentIntoChunks?.(document, indexingContext)
  );

  if (!chunks || chunks.length === 0) {
    throw new Error(`No plugin could split document into chunks: ${r2Key}`);
  }

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

  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) => plugin.prepareSearchQuery?.(query, queryContext)
  );

  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.buildVectorSearchFilter?.(queryContext)
  );

  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses,
    context.env
  );

  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) => plugin.rerankSearchResults?.(results, queryContext)
  );

  const prompt = await runFirstMatchHook(
    context.plugins,
    "composeLlmPrompt",
    (plugin) =>
      plugin.composeLlmPrompt?.(rerankedResults, processedQuery, queryContext)
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  const llmResponse = await callLlm(prompt);

  const formattedResponse = await runWaterfallHook(
    context.plugins,
    "formatFinalResponse",
    llmResponse,
    (response, plugin) =>
      plugin.formatFinalResponse?.(response, rerankedResults, queryContext)
  );

  return formattedResponse;
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

async function callLlm(prompt: string): Promise<string> {
  return callLLM(prompt);
}
