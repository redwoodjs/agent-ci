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
import type { SubjectDO } from "./subjectDb/durableObject";
import {
  getSubject,
  putSubject,
  updateSubjectDocumentIds,
  getSubjectAncestors,
  getSubjectChildren,
  getSubjectByIdempotencyKey,
  listSubjects,
} from "./subjectDb";
import { type subjectMigrations } from "./subjectDb/migrations";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import { summarizeNumerically } from "./utils/vector-summary";

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

  console.log(`[engine] Document split into ${chunks.length} chunks`);

  // 2. Diff against previously processed chunks to avoid redundant work
  const oldChunkHashes = await getProcessedChunkHashes(document.id);
  const oldChunkHashSet = new Set(oldChunkHashes);

  const newChunks = chunks.filter(
    (chunk) => !oldChunkHashSet.has(chunk.contentHash!)
  );

  console.log(
    `[engine] Found ${newChunks.length} new or modified chunks to process out of ${chunks.length} total.`
  );

  if (newChunks.length === 0) {
    console.log(
      `[engine] No new chunks found for document ${document.id}. Indexing is up-to-date.`
    );
    return []; // Nothing more to do
  }

  // 3. Determine subjects for the document (using only new chunks for correlation if needed)
  type SubjectDatabase = Database<typeof subjectMigrations>;
  const subjectDb = createDb<SubjectDatabase>(
    context.env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectDO>,
    "subject-graph"
  );

  // Attempt to use the top-down, source-aware hook first
  const subjectDescriptions = await runFirstMatchHook(
    context.plugins,
    "determineSubjectsForDocument",
    (plugin) =>
      plugin.subjects?.determineSubjectsForDocument?.(
        document,
        newChunks, // Pass only new chunks to the hook
        indexingContext
      )
  );

  if (subjectDescriptions && subjectDescriptions.length > 0) {
    console.log(
      `[engine] Plugin provided ${subjectDescriptions.length} subject descriptions. Processing them now.`
    );
    for (const description of subjectDescriptions) {
      if (!description) {
        continue;
      }

      let narrative = description.narrative;
      if (
        description.narrativeComponents &&
        description.narrativeComponents.length > 0
      ) {
        narrative = await summarizeNumerically(
          description.narrativeComponents,
          context.env
        );
      }

      if (!narrative) {
        console.warn(
          `[engine] Subject description for idempotency key ${description.idempotency_key} has no narrative. Falling back to title.`
        );
        narrative = description.title;
      }

      // Find existing subject by idempotency key
      let subject = await getSubjectByIdempotencyKey(
        subjectDb,
        description.idempotency_key
      );

      if (subject) {
        console.log(
          `[engine] Found existing subject "${subject.title}" (${subject.id}) by idempotency key.`
        );
        // Potentially update title or narrative if they've changed
        subject.title = description.title;
        subject.narrative = narrative;
      } else {
        // Create a new subject
        const subjectId = await hashChunkId(
          `subject:${document.id}:${description.idempotency_key}`
        );
        console.log(
          `[engine] Creating new subject "${description.title}" (${subjectId}) with idempotency key.`
        );
        const newSubject: Subject = {
          id: subjectId,
          title: description.title,
          narrative: narrative,
          documentIds: [],
          idempotency_key: description.idempotency_key,
        };
        subject = newSubject;
      }

      // Link all associated chunks to this subject
      for (const chunk of description.chunks) {
        chunk.metadata.subjectId = subject.id;
      }

      // Save subject and update its vector
      await putSubject(subjectDb, subject);
      await upsertSubjectVector(subject, context.env);
    }
  } else {
    // NO FALLBACK: If no plugin provides top-down subjects, we must throw.
    // This indicates a configuration or plugin logic error that needs to be fixed.
    throw new Error(
      `[engine] No plugin provided subject descriptions for document: ${document.id}. This is a fatal error.`
    );
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
  await setProcessedChunkHashes(document.id, allCurrentChunkHashes);
  console.log(
    `[engine] Successfully updated processed chunk state for ${document.id}.`
  );

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
    console.log(`[query] Added subjectId filter: ${subjectId}`);
  }

  console.log(
    `[query] Step 4: Performing vector search with filters: ${JSON.stringify(
      filterClauses
    )}`
  );
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

export async function findSubjectByQuery(
  queryText: string,
  context: EngineContext
): Promise<Subject | null> {
  const subjectId = await runFirstMatchHook(
    context.plugins,
    "findSubjectForText",
    (plugin) =>
      plugin.subjects?.findSubjectForText?.({
        text: queryText,
        env: context.env,
      })
  );

  if (!subjectId) {
    return null;
  }

  type SubjectDatabase = Database<typeof subjectMigrations>;
  const subjectDb = createDb<SubjectDatabase>(
    context.env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectDO>,
    "subject-graph"
  );

  return await getSubject(subjectDb, subjectId);
}

export async function getSubjectGraphForQuery(
  queryText: string,
  context: EngineContext
) {
  const subject = await findSubjectByQuery(queryText, context);

  if (!subject) {
    return null;
  }

  type SubjectDatabase = Database<typeof subjectMigrations>;
  const subjectDb = createDb<SubjectDatabase>(
    context.env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectDO>,
    "subject-graph"
  );

  const [ancestors, children] = await Promise.all([
    getSubjectAncestors(subjectDb, subject.id),
    getSubjectChildren(subjectDb, subject.id),
  ]);

  return {
    subject,
    ancestors,
    children,
  };
}

export async function listAllSubjects(
  context: EngineContext,
  limit: number = 50,
  offset: number = 0
) {
  type SubjectDatabase = Database<typeof subjectMigrations>;
  const subjectDb = createDb<SubjectDatabase>(
    context.env.SUBJECT_GRAPH_DO as DurableObjectNamespace<SubjectDO>,
    "subject-graph"
  );

  return await listSubjects(subjectDb, limit, offset);
}

async function upsertSubjectVector(subject: Subject, env: Cloudflare.Env) {
  if (!subject.narrative) {
    console.log(`[engine] Subject ${subject.id} has no narrative to index.`);
    return;
  }

  console.log(`[engine] Upserting vector for subject ${subject.id}.`);
  const embeddingResponse = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [subject.narrative],
  })) as { data: number[][] };

  await env.SUBJECT_INDEX.upsert([
    {
      id: subject.id,
      values: embeddingResponse.data[0],
      metadata: { title: subject.title },
    },
  ]);
  console.log(
    `[engine] Successfully upserted vector for subject ${subject.id}.`
  );
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

import { callLLM } from "./utils/llm";

async function callLlm(prompt: string, env: Cloudflare.Env): Promise<string> {
  return callLLM(prompt, env);
}
