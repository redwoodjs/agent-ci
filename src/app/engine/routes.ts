import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  requireQueryApiKey,
  rateLimitQuery,
  validateQueryInput,
} from "./interruptors";
import { query, createEngineContext, indexDocument } from "./index";
import {
  findAncestors,
  getMoment,
  getMoments,
  findLastMomentForDocument,
  getDescendantsForRootSlim,
  getRootStatsByHighImportanceSample,
} from "./momentDb";
import {
  processScannerJob,
  scanForUnprocessedFiles,
  enqueueUnprocessedFiles,
} from "./services/scanner-service";
import { clearAllIndexingState } from "./db";
import {
  getMomentGraphNamespaceFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "./momentGraphNamespace";

async function queryHandler({ request, ctx }: RequestInfo) {
  const body = (ctx as any)?.parsedBody as
    | {
        query?: unknown;
        momentGraphNamespace?: unknown;
        namespace?: unknown;
        momentGraphNamespacePrefix?: unknown;
        namespacePrefix?: unknown;
        responseMode?: unknown;
        clientContext?: unknown;
      }
    | undefined;

  const url = new URL(request.url);
  const queryText =
    (ctx as any).validatedQuery ||
    ((ctx as any).parsedBody as { query?: string })?.query ||
    (typeof body?.query === "string" ? body.query : undefined) ||
    url.searchParams.get("q");

  if (!queryText) {
    return new Response("Missing 'query' parameter", {
      status: 400,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }

  const context = createEngineContext(env as Cloudflare.Env, "querying");

  const namespaceRaw = body?.momentGraphNamespace ?? body?.namespace;
  const momentGraphNamespace =
    typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
      ? namespaceRaw.trim()
      : null;

  const namespacePrefixRaw =
    body?.momentGraphNamespacePrefix ?? body?.namespacePrefix;
  const momentGraphNamespacePrefix =
    typeof namespacePrefixRaw === "string" &&
    namespacePrefixRaw.trim().length > 0
      ? namespacePrefixRaw.trim()
      : null;

  const responseModeRaw =
    body?.responseMode ?? url.searchParams.get("responseMode");
  const responseMode =
    responseModeRaw === "brief" || responseModeRaw === "prompt"
      ? responseModeRaw
      : "answer";

  try {
    console.log(`[query] Starting query: "${queryText}"`);
    const clientContext =
      body?.clientContext && typeof body.clientContext === "object"
        ? (body.clientContext as Record<string, any>)
        : undefined;
    const response = await query(queryText, context, {
      responseMode,
      clientContext,
      momentGraphNamespace,
      momentGraphNamespacePrefix,
    });
    console.log(`[query] Query completed successfully`);
    return new Response(response, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  } catch (error) {
    console.error(
      `[query] Error processing query: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return new Response("Failed to process query", {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
}

async function indexHandler({ request, ctx }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    let body: { r2Key?: string } = {};
    try {
      body = (await request.json()) as { r2Key?: string };
    } catch {
      body = {};
    }

    if (!body.r2Key || typeof body.r2Key !== "string") {
      return Response.json(
        { error: "Missing or invalid 'r2Key' parameter" },
        { status: 400 }
      );
    }

    const envCloudflare = env as Cloudflare.Env;

    console.log(`[index] Indexing single R2 key: ${body.r2Key}`);
    await enqueueUnprocessedFiles([body.r2Key], envCloudflare);

    return Response.json({
      success: true,
      message: `Enqueued file for indexing`,
      r2Key: body.r2Key,
    });
  } catch (error) {
    console.error(
      `[index] Error indexing file: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to index file",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function backfillHandler({ request, ctx }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    let body:
      | {
          prefix?: unknown;
          r2Keys?: unknown;
          momentGraphNamespace?: unknown;
          namespace?: unknown;
        }
      | undefined = undefined;
    try {
      body = (await request.json()) as any;
    } catch {
      body = undefined;
    }

    const envCloudflare = env as Cloudflare.Env;

    const namespaceRaw =
      (body as any)?.momentGraphNamespace ?? (body as any)?.namespace;
    const momentGraphNamespace =
      typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
        ? namespaceRaw.trim()
        : null;

    const namespacePrefixRaw =
      (body as any)?.momentGraphNamespacePrefix ??
      (body as any)?.namespacePrefix;
    const momentGraphNamespacePrefix =
      typeof namespacePrefixRaw === "string" &&
      namespacePrefixRaw.trim().length > 0
        ? namespacePrefixRaw.trim()
        : null;

    const r2KeysRaw = (body as any)?.r2Keys;
    const r2Keys =
      Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
        ? (r2KeysRaw as string[])
        : null;

    const prefixRaw = (body as any)?.prefix;
    const prefix = typeof prefixRaw === "string" ? prefixRaw : "github/";

    const effectiveNamespaceForResponse =
      momentGraphNamespace && momentGraphNamespacePrefix
        ? applyMomentGraphNamespacePrefixValue(
            momentGraphNamespace,
            momentGraphNamespacePrefix
          )
        : momentGraphNamespace;

    if (r2Keys) {
      console.log(
        `[backfill] Indexing ${r2Keys.length} specific R2 keys directly`
      );
      await enqueueUnprocessedFiles(r2Keys, envCloudflare, {
        momentGraphNamespace: momentGraphNamespace,
        momentGraphNamespacePrefix: momentGraphNamespacePrefix,
      });
      return Response.json({
        success: true,
        momentGraphNamespace: effectiveNamespaceForResponse,
        momentGraphNamespacePrefix,
        message: `Enqueued ${r2Keys.length} files for indexing`,
      });
    }

    console.log(`[backfill] Starting manual backfill for prefix: ${prefix}`);

    const unprocessedKeys = await scanForUnprocessedFiles(
      envCloudflare,
      prefix,
      {
        ignoreIndexingState: Boolean(momentGraphNamespacePrefix),
      }
    );

    if (unprocessedKeys.length > 0) {
      await enqueueUnprocessedFiles(unprocessedKeys, envCloudflare, {
        momentGraphNamespace: momentGraphNamespace,
        momentGraphNamespacePrefix: momentGraphNamespacePrefix,
      });
      console.log(
        `[backfill] Manual backfill completed. Enqueued ${unprocessedKeys.length} files.`
      );
      return Response.json({
        success: true,
        momentGraphNamespace: effectiveNamespaceForResponse,
        momentGraphNamespacePrefix,
        message: `Backfill completed. Enqueued ${unprocessedKeys.length} files for indexing.`,
        filesEnqueued: unprocessedKeys.length,
      });
    } else {
      console.log(`[backfill] Manual backfill completed. No files to index.`);
      return Response.json({
        success: true,
        momentGraphNamespace: effectiveNamespaceForResponse,
        momentGraphNamespacePrefix,
        message: "Backfill completed. No files need indexing.",
        filesEnqueued: 0,
      });
    }
  } catch (error) {
    console.error(
      `[backfill] Error starting backfill: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to start backfill",
      },
      { status: 500 }
    );
  }
}

async function resyncHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body:
    | {
        r2Key?: unknown;
        r2Keys?: unknown;
        momentGraphNamespace?: unknown;
        namespace?: unknown;
        mode?: unknown;
      }
    | undefined;

  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const r2KeysRaw = (body as any)?.r2Keys;
  const r2KeyRaw = (body as any)?.r2Key;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : typeof r2KeyRaw === "string"
      ? [r2KeyRaw]
      : null;

  if (!r2Keys || r2Keys.length === 0) {
    return Response.json(
      { error: "Missing or invalid 'r2Keys' or 'r2Key' parameter" },
      { status: 400 }
    );
  }

  const namespaceRaw =
    (body as any)?.momentGraphNamespace ?? (body as any)?.namespace;
  const momentGraphNamespace =
    typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
      ? namespaceRaw.trim()
      : null;

  const namespacePrefixRaw =
    (body as any)?.momentGraphNamespacePrefix ?? (body as any)?.namespacePrefix;
  const momentGraphNamespacePrefix =
    typeof namespacePrefixRaw === "string" &&
    namespacePrefixRaw.trim().length > 0
      ? namespacePrefixRaw.trim()
      : null;

  const modeRaw = (body as any)?.mode;
  const mode = modeRaw === "enqueue" ? "enqueue" : "inline";

  const envCloudflare = env as Cloudflare.Env;
  const effectiveNamespaceForResponse =
    momentGraphNamespace && momentGraphNamespacePrefix
      ? applyMomentGraphNamespacePrefixValue(
          momentGraphNamespace,
          momentGraphNamespacePrefix
        )
      : momentGraphNamespace;

  try {
    if (mode === "enqueue") {
      if (!envCloudflare.ENGINE_INDEXING_QUEUE) {
        return Response.json(
          { error: "ENGINE_INDEXING_QUEUE binding not found" },
          { status: 500 }
        );
      }

      const batchSize = 10;
      for (let i = 0; i < r2Keys.length; i += batchSize) {
        const batch = r2Keys.slice(i, i + batchSize);
        await envCloudflare.ENGINE_INDEXING_QUEUE.sendBatch(
          batch.map((r2Key) => ({
            body: {
              r2Key,
              ...(momentGraphNamespace ? { momentGraphNamespace } : {}),
              ...(momentGraphNamespacePrefix
                ? { momentGraphNamespacePrefix }
                : {}),
            },
          }))
        );
      }

      return Response.json({
        success: true,
        mode,
        momentGraphNamespace: effectiveNamespaceForResponse,
        momentGraphNamespacePrefix,
        r2KeysEnqueued: r2Keys.length,
      });
    }

    const context = createEngineContext(envCloudflare, "indexing");

    const results: Array<{
      r2Key: string;
      chunks: number;
      error?: string;
    }> = [];

    for (const r2Key of r2Keys) {
      try {
        const chunks = await indexDocument(r2Key, context, {
          momentGraphNamespace,
          momentGraphNamespacePrefix,
        });
        results.push({ r2Key, chunks: chunks.length });
      } catch (error) {
        results.push({
          r2Key,
          chunks: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Response.json({
      success: true,
      mode,
      momentGraphNamespace: effectiveNamespaceForResponse,
      momentGraphNamespacePrefix,
      results,
    });
  } catch (error) {
    console.error(
      `[resync] Error processing resync: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to resync",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function clearIndexingStateHandler({ request, ctx }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    console.log(`[admin] Clearing all indexing state`);
    await clearAllIndexingState();
    return Response.json({
      success: true,
      message:
        "All indexing state cleared. Files will be re-indexed on next scan.",
    });
  } catch (error) {
    console.error(
      `[admin] Error clearing indexing state: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to clear indexing state",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function timelineHandler({ request, ctx }: RequestInfo) {
  const url = new URL(request.url);
  const documentId = url.searchParams.get("documentId");

  if (!documentId) {
    return Response.json(
      { error: "Missing 'documentId' parameter" },
      { status: 400 }
    );
  }

  const envCloudflare = env as Cloudflare.Env;

  try {
    console.log(`[timeline] Getting timeline for document: ${documentId}`);

    const momentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: getMomentGraphNamespaceFromEnv(envCloudflare),
    };

    const lastMoment = await findLastMomentForDocument(
      documentId,
      momentGraphContext
    );

    if (!lastMoment) {
      return Response.json(
        { error: "No moments found for document" },
        { status: 404 }
      );
    }

    const timeline = await findAncestors(lastMoment.id, momentGraphContext);

    console.log(
      `[timeline] Found timeline with ${timeline.length} moments for document ${documentId}`
    );

    return Response.json({ timeline });
  } catch (error) {
    console.error(
      `[timeline] Error getting timeline: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to get timeline",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function querySubjectIndexHandler({ request, ctx }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { query?: string };
    const queryText = body.query;

    if (!queryText || typeof queryText !== "string") {
      return Response.json(
        { error: "Missing or invalid 'query' parameter" },
        { status: 400 }
      );
    }

    const envCloudflare = env as Cloudflare.Env;
    const momentGraphNamespace =
      getMomentGraphNamespaceFromEnv(envCloudflare) ?? "default";

    console.log(`[debug] Querying SUBJECT_INDEX for: "${queryText}"`);

    // Generate embedding using the same model as the production code
    const embeddingResponse = (await envCloudflare.AI.run(
      "@cf/baai/bge-base-en-v1.5",
      {
        text: [queryText],
      }
    )) as { data: number[][] };

    if (!embeddingResponse.data || embeddingResponse.data.length === 0) {
      return Response.json(
        { error: "Failed to generate embedding" },
        { status: 500 }
      );
    }

    const vectors = embeddingResponse.data[0];
    console.log(`[debug] Generated embedding (dimension: ${vectors.length})`);

    const queryOptions: Record<string, unknown> = {
      topK: 10,
      returnMetadata: true,
    };
    if (momentGraphNamespace !== "default") {
      queryOptions.filter = { momentGraphNamespace };
    }

    // Query the SUBJECT_INDEX
    const searchResults = await envCloudflare.SUBJECT_INDEX.query(
      vectors,
      queryOptions as any
    );

    console.log(
      `[debug] Vector search found ${searchResults.matches.length} matches`
    );

    const unfilteredMatches = searchResults.matches.map((m) => ({
      id: m.id,
      score: m.score,
      title: (m.metadata as any)?.title,
      momentGraphNamespace: (m.metadata as any)?.momentGraphNamespace ?? null,
    }));

    const matches = unfilteredMatches.filter((m) => {
      const normalizedMatchNamespace = m.momentGraphNamespace ?? "default";
      return normalizedMatchNamespace === momentGraphNamespace;
    });

    return Response.json({
      query: queryText,
      momentGraphNamespace,
      embeddingDimension: vectors.length,
      matches,
      debug: {
        totalMatches: unfilteredMatches.length,
        totalMatchesInNamespace: matches.length,
        topK: 10,
      },
    });
  } catch (error) {
    console.error(
      `[debug] Error querying SUBJECT_INDEX: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return Response.json(
      {
        error: "Failed to query SUBJECT_INDEX",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

async function treeStatsHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body:
    | {
        momentGraphNamespace?: unknown;
        namespace?: unknown;
        momentGraphNamespacePrefix?: unknown;
        namespacePrefix?: unknown;
        highImportanceCutoff?: unknown;
        sampleLimit?: unknown;
        limit?: unknown;
      }
    | undefined;

  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const namespaceRaw =
    (body as any)?.momentGraphNamespace ?? (body as any)?.namespace;
  const baseNamespace =
    typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
      ? namespaceRaw.trim()
      : null;

  if (!baseNamespace) {
    return Response.json(
      { error: "Missing or invalid 'momentGraphNamespace' parameter" },
      { status: 400 }
    );
  }

  const namespacePrefixRaw =
    (body as any)?.momentGraphNamespacePrefix ?? (body as any)?.namespacePrefix;
  const momentGraphNamespacePrefix =
    typeof namespacePrefixRaw === "string" &&
    namespacePrefixRaw.trim().length > 0
      ? namespacePrefixRaw.trim()
      : null;

  const effectiveNamespace = momentGraphNamespacePrefix
    ? applyMomentGraphNamespacePrefixValue(
        baseNamespace,
        momentGraphNamespacePrefix
      )
    : baseNamespace;

  const highRaw = (body as any)?.highImportanceCutoff;
  const highImportanceCutoff =
    typeof highRaw === "number" && Number.isFinite(highRaw) ? highRaw : 0.8;

  const sampleLimitRaw = (body as any)?.sampleLimit;
  const sampleLimit =
    typeof sampleLimitRaw === "number" &&
    Number.isFinite(sampleLimitRaw) &&
    sampleLimitRaw > 0
      ? Math.floor(sampleLimitRaw)
      : 2000;

  const limitRaw = (body as any)?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 20;

  const envCloudflare = env as Cloudflare.Env;

  const roots = await getRootStatsByHighImportanceSample(
    { env: envCloudflare, momentGraphNamespace: effectiveNamespace },
    { highImportanceCutoff, sampleLimit, limit }
  );

  return Response.json({
    momentGraphNamespace: effectiveNamespace,
    momentGraphNamespacePrefix,
    highImportanceCutoff,
    sampleLimit,
    limit,
    roots,
  });
}

async function momentDebugHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body:
    | {
        momentId?: unknown;
        momentGraphNamespace?: unknown;
        namespace?: unknown;
        momentGraphNamespacePrefix?: unknown;
        namespacePrefix?: unknown;
        candidateLimit?: unknown;
        includeCandidateMoments?: unknown;
        includeTree?: unknown;
        treeMaxNodes?: unknown;
      }
    | undefined;

  try {
    body = (await request.json()) as any;
  } catch {
    body = undefined;
  }

  const momentIdRaw = (body as any)?.momentId;
  const momentId =
    typeof momentIdRaw === "string" && momentIdRaw.trim().length > 0
      ? momentIdRaw.trim()
      : null;
  if (!momentId) {
    return Response.json(
      { error: "Missing or invalid 'momentId' parameter" },
      { status: 400 }
    );
  }

  const namespaceRaw =
    (body as any)?.momentGraphNamespace ?? (body as any)?.namespace;
  const baseNamespace =
    typeof namespaceRaw === "string" && namespaceRaw.trim().length > 0
      ? namespaceRaw.trim()
      : null;

  const namespacePrefixRaw =
    (body as any)?.momentGraphNamespacePrefix ?? (body as any)?.namespacePrefix;
  const momentGraphNamespacePrefix =
    typeof namespacePrefixRaw === "string" &&
    namespacePrefixRaw.trim().length > 0
      ? namespacePrefixRaw.trim()
      : null;

  const envCloudflare = env as Cloudflare.Env;
  const effectiveNamespace =
    momentGraphNamespacePrefix && baseNamespace
      ? applyMomentGraphNamespacePrefixValue(
          baseNamespace,
          momentGraphNamespacePrefix
        )
      : baseNamespace ?? getMomentGraphNamespaceFromEnv(envCloudflare);

  const momentGraphContext = {
    env: envCloudflare,
    momentGraphNamespace: effectiveNamespace,
  };

  const moment = await getMoment(momentId, momentGraphContext);
  if (!moment) {
    return Response.json({ error: "Moment not found" }, { status: 404 });
  }

  const ancestors = await findAncestors(moment.id, momentGraphContext);
  const root = ancestors[0] ?? null;

  const candidateLimitRaw = (body as any)?.candidateLimit;
  const candidateLimit =
    typeof candidateLimitRaw === "number" &&
    Number.isFinite(candidateLimitRaw) &&
    candidateLimitRaw > 0
      ? Math.floor(candidateLimitRaw)
      : 10;

  const includeCandidateMoments = Boolean(
    (body as any)?.includeCandidateMoments
  );

  const auditLog = moment.linkAuditLog ?? null;

  let candidateMoments: Record<string, any> | null = null;
  if (
    includeCandidateMoments &&
    auditLog &&
    Array.isArray((auditLog as any).candidates)
  ) {
    const candidateIds = ((auditLog as any).candidates as any[])
      .map((c) => c?.id)
      .filter(
        (id: unknown): id is string => typeof id === "string" && id.length > 0
      )
      .slice(0, candidateLimit);
    const uniqueIds = Array.from(new Set(candidateIds));
    if (uniqueIds.length > 0) {
      const map = await getMoments(uniqueIds, momentGraphContext);
      const out: Record<string, any> = {};
      for (const id of uniqueIds) {
        const m = map.get(id);
        if (m) {
          out[id] = {
            id: m.id,
            title: m.title,
            summary: m.summary,
            documentId: m.documentId,
            parentId: m.parentId ?? null,
            createdAt: m.createdAt,
          };
        }
      }
      candidateMoments = out;
    }
  }

  const includeTree = Boolean((body as any)?.includeTree);
  const treeMaxNodesRaw = (body as any)?.treeMaxNodes;
  const treeMaxNodes =
    typeof treeMaxNodesRaw === "number" &&
    Number.isFinite(treeMaxNodesRaw) &&
    treeMaxNodesRaw > 0
      ? Math.floor(treeMaxNodesRaw)
      : 5000;

  const tree =
    includeTree && root
      ? await getDescendantsForRootSlim(root.id, momentGraphContext, {
          maxNodes: treeMaxNodes,
        })
      : null;

  return Response.json({
    momentGraphNamespace: effectiveNamespace ?? null,
    momentGraphNamespacePrefix: momentGraphNamespacePrefix ?? null,
    moment: {
      id: moment.id,
      documentId: moment.documentId,
      title: moment.title,
      summary: moment.summary,
      parentId: moment.parentId ?? null,
      createdAt: moment.createdAt,
      author: moment.author,
      importance: moment.importance ?? null,
    },
    root: root
      ? {
          id: root.id,
          title: root.title,
          documentId: root.documentId,
        }
      : null,
    tree: tree
      ? {
          nodes: tree.nodes,
          truncated: tree.truncated,
          maxNodes: treeMaxNodes,
        }
      : null,
    linkage: {
      auditLog,
      candidateLimit,
      candidateMoments,
    },
  });
}

export const routes = [
  route("/query", {
    post: [
      requireQueryApiKey,
      rateLimitQuery,
      validateQueryInput,
      queryHandler,
    ],
    get: [requireQueryApiKey, rateLimitQuery, validateQueryInput, queryHandler],
  }),
  route("/admin/index", {
    post: [requireQueryApiKey, indexHandler],
  }),
  route("/admin/backfill", {
    post: [requireQueryApiKey, backfillHandler],
  }),
  route("/admin/resync", {
    post: [requireQueryApiKey, resyncHandler],
  }),
  route("/admin/clear-indexing-state", {
    post: [requireQueryApiKey, clearIndexingStateHandler],
  }),
  route("/admin/tree-stats", {
    post: [requireQueryApiKey, treeStatsHandler],
  }),
  route("/admin/moment-debug", {
    post: [requireQueryApiKey, momentDebugHandler],
  }),
  route("/debug/query-subject-index", {
    post: [requireQueryApiKey, querySubjectIndexHandler],
  }),
  route("/timeline", {
    get: [requireQueryApiKey, timelineHandler],
  }),
];

export const queryRoutes = [
  route("/", {
    post: [
      requireQueryApiKey,
      rateLimitQuery,
      validateQueryInput,
      queryHandler,
    ],
    get: [requireQueryApiKey, rateLimitQuery, validateQueryInput, queryHandler],
  }),
];
