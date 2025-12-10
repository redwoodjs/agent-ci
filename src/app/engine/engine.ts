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
  Moment,
} from "./types";
import { createDb, type Database } from "rwsdk/db";
import type { SubjectDO } from "./subjectDb/durableObject";
import {
  getSubject,
  getSubjectAncestors,
  getSubjectChildren,
  listSubjects,
} from "./subjectDb";
import { type subjectMigrations } from "./subjectDb/migrations";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import { addMoment, findSimilarMoments, findAncestors } from "./momentDb";

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

  // 1. Split document into chunks BEFORE subject correlation
  let chunks: Chunk[] | null = null;
  const step2Start = Date.now();
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
  console.log(
    `[engine] splitDocumentIntoChunks took ${Date.now() - step2Start}ms`
  );

  if (!chunks || chunks.length === 0) {
    throw new Error(`No plugin could split document into chunks: ${r2Key}`);
  }

  console.log(`[engine] Document split into ${chunks.length} chunks`);

  // 2. Diff against previously processed chunks to avoid redundant work
  const oldChunkHashes = await getProcessedChunkHashes(r2Key);
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

  // 3. Extract moments from the document
  // Subjects are now created automatically from root moments via the Moment Graph system.
  // Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects.
  const momentDescriptions = await runFirstMatchHook(
    context.plugins,
    "extractMomentsFromDocument",
    (plugin) =>
      plugin.subjects?.extractMomentsFromDocument?.(document, indexingContext)
  );

  if (momentDescriptions && momentDescriptions.length > 0) {
    console.log(
      `[engine] Plugin provided ${momentDescriptions.length} moment descriptions. Processing them now.`
    );

    let previousMomentId: string | undefined = undefined;

    for (let i = 0; i < momentDescriptions.length; i++) {
      const description = momentDescriptions[i];
      if (!description) {
        continue;
      }

      const summary = await runFirstMatchHook(
        context.plugins,
        "summarizeMomentContent",
        (plugin) =>
          plugin.subjects?.summarizeMomentContent?.(
            description.content,
            indexingContext
          )
      );

      if (!summary) {
        console.warn(
          `[engine] No plugin provided summary for moment ${i + 1}. Skipping.`
        );
        continue;
      }

      const momentId = crypto.randomUUID();
      const moment: Moment = {
        id: momentId,
        documentId: document.id,
        summary: summary,
        title: description.title,
        parentId: previousMomentId,
        createdAt: description.createdAt,
        author: description.author,
        sourceMetadata: description.sourceMetadata,
      };

      await addMoment(moment);

      console.log(
        `[engine] Created moment ${momentId} (parent: ${
          previousMomentId || "root"
        })`
      );

      previousMomentId = momentId;
    }
  } else {
    console.log(
      `[engine] No plugin provided moment descriptions for document: ${document.id}. Skipping moment extraction.`
    );
  }

  // 4. Enrich chunks (optional, original logic for the new chunks)
  const step3Start = Date.now();
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
  console.log(
    `[engine] enrichChunks (all chunks) took ${Date.now() - step3Start}ms`
  );

  // 5. After successful processing, update the state with the hashes of *all* current chunks
  const allCurrentChunkHashes = chunks.map((c) => c.contentHash!);
  await setProcessedChunkHashes(r2Key, allCurrentChunkHashes);
  console.log(
    `[engine] Successfully updated processed chunk state for ${document.id}.`
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

  // Narrative Query Path: Try to answer using Subject (root moment) first
  console.log(
    `[query:narrative] Step 0: Attempting narrative query via Subject Graph...`
  );
  console.log(`[query:narrative] User query: "${userQuery}"`);
  try {
    const embeddingStart = Date.now();
    const queryEmbedding = await generateEmbedding(userQuery);
    console.log(
      `[query:narrative] Generated query embedding in ${
        Date.now() - embeddingStart
      }ms (dimension: ${queryEmbedding.length})`
    );

    const { findSimilarSubjects, findDescendants } = await import("./momentDb");
    const subjectSearchStart = Date.now();
    const similarSubjects = await findSimilarSubjects(queryEmbedding, 1);
    console.log(
      `[query:narrative] Subject search completed in ${
        Date.now() - subjectSearchStart
      }ms`
    );

    if (similarSubjects.length > 0) {
      const subjectMoment = similarSubjects[0];
      console.log(
        `[query:narrative] ✓ Found relevant Subject: ${subjectMoment.id} (${subjectMoment.title})`
      );
      console.log(
        `[query:narrative] Subject summary: "${subjectMoment.summary.substring(
          0,
          100
        )}..."`
      );

      // Get the full narrative timeline (root moment + all descendants)
      const timelineStart = Date.now();
      const timeline = await findDescendants(subjectMoment.id);
      console.log(
        `[query:narrative] Timeline retrieval completed in ${
          Date.now() - timelineStart
        }ms`
      );
      console.log(
        `[query:narrative] ✓ Reconstructed Subject timeline with ${timeline.length} moments:`
      );
      timeline.forEach((moment, idx) => {
        console.log(
          `[query:narrative]   ${idx + 1}. ${moment.title} (${moment.id})`
        );
      });

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

        const llmStart = Date.now();
        const narrativeAnswer = await callLlm(narrativePrompt);
        console.log(
          `[query:narrative] LLM call completed in ${Date.now() - llmStart}ms`
        );
        console.log(
          `[query:narrative] ✓ Narrative query path succeeded. Total time: ${
            Date.now() - totalStart
          }ms`
        );
        console.log(
          `[query:narrative] Answer length: ${narrativeAnswer.length} characters`
        );
        return narrativeAnswer;
      } else {
        console.log(
          `[query:narrative] Timeline is empty, falling back to chunk-based RAG`
        );
      }
    } else {
      console.log(
        `[query:narrative] No Subjects found matching query, falling back to chunk-based RAG`
      );
    }
  } catch (error) {
    console.error(
      `[query:narrative] ✗ Narrative query path failed, falling back to chunk-based RAG:`,
      error
    );
    // Fall through to the existing chunk-based RAG system
  }

  console.log(`[query] Preparing search query...`);
  const step1Start = Date.now();
  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) =>
      plugin.evidence?.prepareSearchQuery?.(query, queryContext)
  );
  console.log(
    `[query] Search query preparation took ${Date.now() - step1Start}ms`
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
  const step2Start = Date.now();
  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.evidence?.buildVectorSearchFilter?.(queryContext)
  );
  console.log(
    `[query] Vector search filter build took ${Date.now() - step2Start}ms`
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
  const step3Start = Date.now();
  const searchResults = await performVectorSearch(
    processedQuery,
    filterClauses
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

  console.log(`[query] Step 5: Reranking results`);
  const step4Start = Date.now();
  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) =>
      plugin.evidence?.rerankSearchResults?.(results, queryContext)
  );
  console.log(`[query] Result reranking took ${Date.now() - step4Start}ms`);

  console.log(`[query] Step 6: Reconstructing contexts`);
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

  console.log(`[query] Step 7: Optimizing contexts`);
  const step55Start = Date.now();
  const optimizedContexts = await runWaterfallHook(
    context.plugins,
    "optimizeContext",
    reconstructedContexts,
    (contexts, plugin) =>
      plugin.evidence?.optimizeContext?.(contexts, processedQuery, queryContext)
  );
  console.log(
    `[query] Context optimization took ${Date.now() - step55Start}ms`
  );
  console.log(`[query] Optimized to ${optimizedContexts.length} contexts`);

  console.log(`[query] Step 8: Composing LLM prompt`);
  const step6Start = Date.now();
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
  console.log(
    `[query] LLM prompt composition took ${Date.now() - step6Start}ms`
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  console.log(
    `[query] Step 9: Calling LLM (prompt length: ${prompt.length} chars)`
  );
  const step7Start = Date.now();
  const llmResponse = await callLlm(prompt);
  console.log(`[query] LLM generation took ${Date.now() - step7Start}ms`);
  console.log(
    `[query] Step 10: LLM response received (length: ${llmResponse.length} chars)`
  );

  console.log(`[query] Step 11: Formatting final response`);
  const step9Start = Date.now();
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
  console.log(
    `[query] Final response formatting took ${Date.now() - step9Start}ms`
  );

  console.log(`[query] Total query time took ${Date.now() - totalStart}ms`);
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

  const documentEntries = Array.from(chunksByDocument.entries());
  const CONCURRENT_FETCH_LIMIT = 6;
  const fetchResults: Array<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
    fetchTime: number;
  }> = [];

  async function fetchAndReadDocument(
    documentId: string,
    documentChunks: ChunkMetadata[]
  ): Promise<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
    fetchTime: number;
  }> {
    const r2Start = Date.now();
    const object = await bucket.get(documentId);
    const fetchTime = Date.now() - r2Start;

    if (!object) {
      console.log(
        `[query] R2 fetch for ${documentId} took ${fetchTime}ms (not found)`
      );
      return { documentId, documentChunks, sourceDocument: null, fetchTime };
    }

    const jsonText = await object.text();
    let sourceDocument: any;
    try {
      sourceDocument = JSON.parse(jsonText);
    } catch (error) {
      sourceDocument = jsonText;
    }

    console.log(
      `[query] R2 fetch and read for ${documentId} took ${
        Date.now() - r2Start
      }ms`
    );
    return { documentId, documentChunks, sourceDocument, fetchTime };
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

  console.log(
    `[query] All R2 fetches completed in ${Date.now() - fetchStart}ms (${
      fetchResults.length
    } documents, max ${CONCURRENT_FETCH_LIMIT} concurrent)`
  );

  const reconstructedContexts: ReconstructedContext[] = [];

  for (const { documentId, documentChunks, sourceDocument } of fetchResults) {
    if (!sourceDocument) {
      continue;
    }

    const pluginStart = Date.now();
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
  filterClauses: Record<string, unknown>[]
): Promise<ChunkMetadata[]> {
  const embedStart = Date.now();
  const embedding = await generateEmbedding(query);
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

async function generateEmbedding(text: string): Promise<number[]> {
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

import { env } from "cloudflare:workers";
import { callLLM } from "./utils/llm";

async function callLlm(prompt: string): Promise<string> {
  return callLLM(prompt);
}
