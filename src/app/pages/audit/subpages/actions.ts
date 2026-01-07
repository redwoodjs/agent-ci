"use server";

import { env } from "cloudflare:workers";
import { enqueueUnprocessedFiles } from "@/app/engine/services/scanner-service";
import { query } from "@/app/engine/engine";
import {
  githubPlugin,
  discordPlugin,
  defaultPlugin,
} from "@/app/engine/plugins";
import type { EngineContext } from "@/app/engine/types";
import {
  getKnowledgeGraphStructure,
  getKnowledgeGraphStats,
  getRootMoments,
  getDescendantsForRoot,
  getDescendantsForRootSlim,
  getRootStatsByHighImportanceSample,
  findAncestors,
  getMoments,
  getMoment,
  getMicroMomentsByPaths,
  getDocumentAuditLogsForDocument,
} from "@/app/engine/momentDb";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";
import { getEmbedding } from "@/app/engine/utils/vector";

export async function enqueueFile(r2Key: string) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    await enqueueUnprocessedFiles([r2Key], envCloudflare);
    return { success: true, message: `Enqueued file for indexing`, r2Key };
  } catch (error) {
    console.error("[actions] Error enqueuing file:", error);
    return {
      success: false,
      error: "Failed to enqueue file",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function enqueueFiles(r2Keys: string[]) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    await enqueueUnprocessedFiles(r2Keys, envCloudflare);
    return {
      success: true,
      message: `Enqueued ${r2Keys.length} files for indexing`,
      count: r2Keys.length,
    };
  } catch (error) {
    console.error("[actions] Error enqueuing files:", error);
    return {
      success: false,
      error: "Failed to enqueue files",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deleteFile(r2Key: string) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    await envCloudflare.MACHINEN_BUCKET.delete(r2Key);
    return { success: true, message: `Deleted file: ${r2Key}`, r2Key };
  } catch (error) {
    console.error("[actions] Error deleting file:", error);
    return {
      success: false,
      error: "Failed to delete file",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function deleteFiles(r2Keys: string[]) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    await Promise.all(
      r2Keys.map((key) => envCloudflare.MACHINEN_BUCKET.delete(key))
    );
    return {
      success: true,
      message: `Deleted ${r2Keys.length} files`,
      count: r2Keys.length,
    };
  } catch (error) {
    console.error("[actions] Error deleting files:", error);
    return {
      success: false,
      error: "Failed to delete files",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function queryRag(queryText: string) {
  try {
    // Validate query length (matching the interruptor validation)
    if (!queryText || typeof queryText !== "string") {
      return {
        success: false,
        error: "Missing 'query' parameter",
      };
    }

    if (queryText.length > 1000) {
      return {
        success: false,
        error: "Query too long. Maximum 1000 characters.",
      };
    }

    if (queryText.length < 3) {
      return {
        success: false,
        error: "Query too short. Minimum 3 characters.",
      };
    }

    const context: EngineContext = {
      plugins: [githubPlugin, discordPlugin, defaultPlugin],
      env: env as Cloudflare.Env,
    };

    console.log(`[query-action] Starting query: "${queryText}"`);
    const response = await query(queryText, context);
    console.log(`[query-action] Query completed successfully`);

    return {
      success: true,
      response: response,
    };
  } catch (error) {
    console.error("[actions] Error querying RAG:", error);
    return {
      success: false,
      error: "Failed to query RAG engine",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getKnowledgeGraph(options?: {
  limit?: number;
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const graphData = await getKnowledgeGraphStructure(context, {
      limit: options?.limit ?? 1000,
    });

    return {
      success: true,
      data: graphData,
      count: graphData.length,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching knowledge graph:", error);
    return {
      success: false,
      error: "Failed to fetch knowledge graph",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getKnowledgeGraphStatsAction(options?: {
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const stats = await getKnowledgeGraphStats(context);

    return {
      success: true,
      stats,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching knowledge graph stats:", error);
    return {
      success: false,
      error: "Failed to fetch knowledge graph stats",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getMomentGraphNamespacePrefix() {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const prefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    return {
      success: true,
      prefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching namespace prefix:", error);
    return {
      success: false,
      error: "Failed to fetch namespace prefix",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getRootMomentsAction(options?: {
  limit?: number;
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const rootMoments = await getRootMoments(context, {
      limit: options?.limit ?? 1000,
    });

    return {
      success: true,
      data: rootMoments,
      count: rootMoments.length,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching root moments:", error);
    return {
      success: false,
      error: "Failed to fetch root moments",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getDescendantsForRootAction(
  rootId: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
  }
) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const descendants = await getDescendantsForRoot(rootId, context);

    return {
      success: true,
      data: descendants,
      count: descendants.length,
      rootId,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching descendants:", error);
    return {
      success: false,
      error: "Failed to fetch descendants",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getDescendantsForRootSlimAction(
  rootId: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
    maxNodes?: number;
  }
) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const maxNodesRaw = options?.maxNodes;
    const maxNodes =
      typeof maxNodesRaw === "number" && Number.isFinite(maxNodesRaw) && maxNodesRaw > 0
        ? Math.floor(maxNodesRaw)
        : 5000;

    const result = await getDescendantsForRootSlim(rootId, context, { maxNodes });

    return {
      success: true,
      data: result.nodes,
      count: result.nodes.length,
      truncated: result.truncated,
      maxNodes,
      rootId,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching slim descendants:", error);
    return {
      success: false,
      error: "Failed to fetch descendants",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getMomentDetailsAction(
  id: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
    includeProvenance?: boolean;
    provenanceMaxChunkIds?: number;
    includeDocumentAudit?: boolean;
    documentAuditLimit?: number;
  }
) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const moment = await getMoment(id, context);
    const includeProvenance = Boolean(options?.includeProvenance);
    const provenanceMaxChunkIdsRaw = options?.provenanceMaxChunkIds;
    const provenanceMaxChunkIds =
      typeof provenanceMaxChunkIdsRaw === "number" &&
      Number.isFinite(provenanceMaxChunkIdsRaw) &&
      provenanceMaxChunkIdsRaw > 0
        ? Math.floor(provenanceMaxChunkIdsRaw)
        : 40;

    let provenance: Record<string, any> | null = null;
    if (includeProvenance && moment) {
      const sourceMetadata = moment.sourceMetadata ?? null;
      const streamIdRaw =
        sourceMetadata && typeof (sourceMetadata as any).streamId === "string"
          ? ((sourceMetadata as any).streamId as string)
          : null;
      const timeRangeRaw =
        sourceMetadata && typeof (sourceMetadata as any).timeRange === "object"
          ? ((sourceMetadata as any).timeRange as any)
          : null;
      const timeRange =
        timeRangeRaw &&
        typeof timeRangeRaw?.start === "string" &&
        typeof timeRangeRaw?.end === "string"
          ? { start: timeRangeRaw.start, end: timeRangeRaw.end }
          : null;

      const microPaths = Array.isArray(moment.microPaths) ? moment.microPaths : [];
      const microMoments =
        microPaths.length > 0
          ? await getMicroMomentsByPaths(moment.documentId, microPaths, context)
          : [];

      const chunkIds: string[] = [];
      for (const mm of microMoments) {
        const idsRaw = (mm.sourceMetadata as any)?.chunkIds;
        if (Array.isArray(idsRaw)) {
          for (const id of idsRaw) {
            if (typeof id === "string" && id.length > 0) {
              chunkIds.push(id);
            }
          }
        }
      }

      const uniqueChunkIds = Array.from(new Set(chunkIds)).slice(
        0,
        provenanceMaxChunkIds
      );

      const discordMessageIds: string[] = [];
      for (const id of uniqueChunkIds) {
        const idx = id.indexOf("#message-");
        if (idx >= 0) {
          const msgId = id.slice(idx + "#message-".length);
          if (msgId && /^\d+$/.test(msgId)) {
            discordMessageIds.push(msgId);
          }
        }
      }

      provenance = {
        streamId: streamIdRaw,
        timeRange,
        microPathsCount: microPaths.length,
        chunkIdsSample: uniqueChunkIds,
        discordMessageIdsSample: Array.from(new Set(discordMessageIds)).slice(0, 40),
        ingestionFilePath: `/audit/ingestion/file/${encodeURIComponent(
          moment.documentId
        )}`,
      };
    }

    const includeDocumentAuditRaw = options?.includeDocumentAudit;
    const includeDocumentAudit =
      typeof includeDocumentAuditRaw === "boolean" ? includeDocumentAuditRaw : true;
    const documentAuditLimitRaw = options?.documentAuditLimit;
    const documentAuditLimit =
      typeof documentAuditLimitRaw === "number" &&
      Number.isFinite(documentAuditLimitRaw) &&
      documentAuditLimitRaw > 0
        ? Math.floor(documentAuditLimitRaw)
        : 10;

    const documentAudit =
      includeDocumentAudit && moment
        ? await getDocumentAuditLogsForDocument(moment.documentId, context, {
            kindPrefix: "synthesis:",
            limit: documentAuditLimit,
          })
        : null;

    return {
      success: true,
      data: moment ? { ...(moment as any), provenance, documentAudit } : moment,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching moment details:", error);
    return {
      success: false,
      error: "Failed to fetch moment",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getRootSampleStatsAction(options?: {
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
  highImportanceCutoff?: number;
  sampleLimit?: number;
  limit?: number;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const highImportanceCutoff =
      typeof options?.highImportanceCutoff === "number" &&
      Number.isFinite(options.highImportanceCutoff)
        ? options.highImportanceCutoff
        : 0.8;
    const sampleLimit =
      typeof options?.sampleLimit === "number" && Number.isFinite(options.sampleLimit)
        ? options.sampleLimit
        : 2000;
    const limit =
      typeof options?.limit === "number" && Number.isFinite(options.limit)
        ? options.limit
        : 50;

    if (!effectiveNamespace) {
      return {
        success: false,
        error: "Missing namespace",
      };
    }

    const roots = await getRootStatsByHighImportanceSample(
      { env: envCloudflare, momentGraphNamespace: effectiveNamespace },
      {
        highImportanceCutoff,
        sampleLimit,
        limit,
      }
    );

    return {
      success: true,
      roots,
      effectiveNamespace,
      prefix: effectivePrefix,
      highImportanceCutoff,
      sampleLimit,
      limit,
    };
  } catch (error) {
    console.error("[actions] Error fetching root sample stats:", error);
    return {
      success: false,
      error: "Failed to fetch root sample stats",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function searchMomentsAction(options: {
  query: string;
  limit?: number;
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;

    const queryText =
      typeof options.query === "string" ? options.query.trim() : "";
    if (!queryText) {
      return {
        success: false,
        error: "Missing query",
      };
    }

    const limitRaw = options.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : 10;

    const baseNamespace = options.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" && prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const context = {
      env: envCloudflare,
      momentGraphNamespace: effectiveNamespace,
    };

    const embedding = await getEmbedding(queryText);
    const queryOptions: Record<string, unknown> = {
      topK: limit,
      returnMetadata: true,
    };
    if (effectiveNamespace && effectiveNamespace !== "default") {
      queryOptions.filter = { momentGraphNamespace: effectiveNamespace };
    }

    const results = await envCloudflare.MOMENT_INDEX.query(
      embedding,
      queryOptions as any
    );

    const matchIds = (results.matches ?? [])
      .map((m) => m?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    const momentsMap =
      matchIds.length > 0 ? await getMoments(matchIds, context) : new Map();

    const out: Array<{
      matchId: string;
      score: number;
      matchTitle: string;
      matchSummary: string;
      matchDocumentId: string;
      rootId: string;
      rootTitle: string;
    }> = [];

    for (const match of results.matches ?? []) {
      const id = typeof match?.id === "string" ? match.id : null;
      const score = typeof match?.score === "number" ? match.score : null;
      if (!id || score === null) {
        continue;
      }
      const moment = momentsMap.get(id);
      if (!moment) {
        continue;
      }
      const ancestors = await findAncestors(moment.id, context);
      const root = ancestors[0];
      if (!root) {
        continue;
      }
      out.push({
        matchId: moment.id,
        score,
        matchTitle: moment.title,
        matchSummary: moment.summary,
        matchDocumentId: moment.documentId,
        rootId: root.id,
        rootTitle: root.title,
      });
    }

    out.sort((a, b) => b.score - a.score);

    return {
      success: true,
      results: out,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error searching moments:", error);
    return {
      success: false,
      error: "Failed to search moments",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}
