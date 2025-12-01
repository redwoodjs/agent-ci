import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  EngineContext,
  ReconstructedContext,
  Subject,
  SubjectSearchContext,
} from "./types";
import { createDb, type Database } from "rwsdk/db";
import type { SubjectGraphDO } from "./subjectDb/durableObject";
import { getSubject, putSubject, updateSubjectDocumentIds } from "./subjectDb";
import { type subjectMigrations } from "./subjectDb/migrations";

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

  // Find or create subject for this document
  console.log(`[engine] Finding subject for document`);

  type SubjectDatabase = Database<typeof subjectMigrations>;
  const subjectDb = createDb<SubjectDatabase>(
    context.env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectGraphDO>,
    "subject-graph"
  );

  // Check if this is an update: look for existing subject with this document ID
  // For the Skateboard, we check if a subject exists with ID = document.id
  // (since we use document.id as fallback subjectId)
  const existingSubject = await getSubject(subjectDb, document.id);

  let subjectId: string;
  if (existingSubject && existingSubject.documentIds.includes(document.id)) {
    // Document update: reuse the existing subject
    subjectId = existingSubject.id;
    console.log(
      `[engine] Document update detected, reusing subject: ${subjectId}`
    );
  } else {
    // New document: search for relevant subject or create new one
    const foundSubjectId = await runFirstMatchHook(
      context.plugins,
      "findSubjectForText",
      (plugin) =>
        plugin.subjects?.findSubjectForText?.({
          text: document.metadata.title || document.content.substring(0, 200),
          env: context.env,
        })
    );

    // If no subject found, create a new one using document.id as subjectId
    subjectId = foundSubjectId || document.id;
    console.log(
      `[engine] ${foundSubjectId ? "Found" : "Creating"} subject: ${subjectId}`
    );
  }

  document.subjectId = subjectId;

  // Get or create the subject
  const currentSubject = await getSubject(subjectDb, subjectId);

  if (!currentSubject) {
    // Create new subject in DO
    const newSubject: Subject = {
      id: subjectId,
      title: document.metadata.title || r2Key,
      documentIds: [document.id],
    };
    await putSubject(subjectDb, newSubject);

    // Index subject title in SUBJECT_INDEX
    const embeddingResponse = (await context.env.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      { text: [newSubject.title] }
    )) as { data: number[][] };
    await context.env.SUBJECT_INDEX.insert([
      {
        id: subjectId,
        values: embeddingResponse.data[0],
        metadata: {
          title: newSubject.title,
        },
      },
    ]);
  } else {
    // Update existing subject to include this document (if not already present)
    if (!currentSubject.documentIds.includes(document.id)) {
      await updateSubjectDocumentIds(subjectDb, subjectId, document.id);
    }
  }

  // Try each plugin until we get non-empty chunks
  // Empty arrays are treated as "no match" to allow the correct plugin to handle it
  let chunks: Chunk[] | null = null;
  for (const plugin of context.plugins) {
    if (plugin.evidence?.splitDocumentIntoChunks) {
      const result = await plugin.evidence.splitDocumentIntoChunks(
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
    (query, plugin) =>
      plugin.evidence?.prepareSearchQuery?.(query, queryContext)
  );

  console.log(`[query] Step 2: Finding relevant subject`);
  const subjectId = await runFirstMatchHook(
    context.plugins,
    "findSubjectForText",
    (plugin) =>
      plugin.subjects?.findSubjectForText?.({
        text: userQuery,
        env: context.env,
      })
  );

  if (subjectId) {
    console.log(`[query] Found subject: ${subjectId}`);
  } else {
    console.log(`[query] No subject found for query`);
  }

  console.log(`[query] Step 3: Building vector search filter`);
  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.evidence?.buildVectorSearchFilter?.(queryContext)
  );

  // Add subjectId filter if we found one
  if (subjectId) {
    filterClauses.push({ subjectId });
  }

  console.log(`[query] Step 4: Performing vector search`);
  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses,
    context.env
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

  console.log(`[query] Step 5: Reranking results`);
  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) =>
      plugin.evidence?.rerankSearchResults?.(results, queryContext)
  );

  console.log(`[query] Step 6: Reconstructing contexts`);
  const reconstructedContexts = await reconstructContexts(
    rerankedResults,
    context.plugins,
    queryContext
  );
  console.log(`[query] Reconstructed ${reconstructedContexts.length} contexts`);

  console.log(`[query] Step 7: Optimizing contexts`);
  const optimizedContexts = await runWaterfallHook(
    context.plugins,
    "optimizeContext",
    reconstructedContexts,
    (contexts, plugin) =>
      plugin.evidence?.optimizeContext?.(contexts, processedQuery, queryContext)
  );
  console.log(`[query] Optimized to ${optimizedContexts.length} contexts`);

  console.log(`[query] Step 8: Composing LLM prompt`);

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

  console.log(
    `[query] Step 9: Calling LLM (prompt length: ${prompt.length} chars)`
  );

  const llmResponse = await callLlm(prompt, context.env);
  console.log(
    `[query] Step 10: LLM response received (length: ${llmResponse.length} chars)`
  );

  console.log(`[query] Step 11: Formatting final response`);
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
  filterClauses: Record<string, unknown>[],
  env: Cloudflare.Env
): Promise<ChunkMetadata[]> {
  const embedding = await generateEmbedding(query, env);

  const combinedFilter = combineFilterClauses(
    filterClauses as Record<string, unknown>[]
  );

  console.log(`[query] Vector search filter:`, JSON.stringify(combinedFilter));
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
