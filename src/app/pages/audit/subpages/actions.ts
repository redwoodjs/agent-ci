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
  getRecentDocumentAuditEvents,
  type MomentGraphContext,
} from "@/app/engine/momentDb";
import { MomentGraphDO } from "@/app/engine/momentDb/durableObject";
import { type Database, createDb } from "rwsdk/db";
import { type momentMigrations } from "@/app/engine/momentDb/migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";
import { qualifyName } from "@/app/engine/momentGraphNamespace";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";
import { getEmbedding } from "@/app/engine/utils/vector";

// Local types and helpers for audit-specific functions
type MomentDatabase = Database<typeof momentMigrations>;
type MomentInput = MomentDatabase["moments"];
type MomentRow = Override<
  MomentInput,
  {
    micro_paths_json: string[] | null;
    source_metadata: Record<string, any> | null;
    link_audit_log: Record<string, any> | null;
  }
>;

function getMomentDb(context: MomentGraphContext) {
  return createDb<MomentDatabase>(
    context.env.MOMENT_GRAPH_DO as DurableObjectNamespace<MomentGraphDO>,
    qualifyName("moment-graph-v2", context.momentGraphNamespace)
  );
}

function parseSourceFromDocumentId(
  documentId: string
): "github" | "discord" | "cursor" | "unknown" {
  if (typeof documentId !== "string" || documentId.length === 0) {
    return "unknown";
  }
  if (documentId.startsWith("github/")) {
    return "github";
  }
  if (documentId.startsWith("discord/")) {
    return "discord";
  }
  if (documentId.startsWith("cursor/")) {
    return "cursor";
  }
  return "unknown";
}

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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof maxNodesRaw === "number" &&
      Number.isFinite(maxNodesRaw) &&
      maxNodesRaw > 0
        ? Math.floor(maxNodesRaw)
        : 5000;

    const result = await getDescendantsForRootSlim(rootId, context, {
      maxNodes,
    });

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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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

      const microPaths = Array.isArray(moment.microPaths)
        ? moment.microPaths
        : [];
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
        discordMessageIdsSample: Array.from(new Set(discordMessageIds)).slice(
          0,
          40
        ),
        ingestionFilePath: `/audit/ingestion/file/${encodeURIComponent(
          moment.documentId
        )}`,
      };
    }

    const includeDocumentAuditRaw = options?.includeDocumentAudit;
    const includeDocumentAudit =
      typeof includeDocumentAuditRaw === "boolean"
        ? includeDocumentAuditRaw
        : true;
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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
      typeof options?.sampleLimit === "number" &&
      Number.isFinite(options.sampleLimit)
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

export async function getDocumentAuditLogsAction(
  documentId: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
    kindPrefix?: string | null;
    limit?: number;
  }
) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const kindPrefixRaw = options?.kindPrefix;
    const kindPrefix =
      typeof kindPrefixRaw === "string" && kindPrefixRaw.trim().length > 0
        ? kindPrefixRaw.trim()
        : null;
    const limitRaw = options?.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : 50;

    const logs = await getDocumentAuditLogsForDocument(
      documentId,
      { env: envCloudflare, momentGraphNamespace: effectiveNamespace },
      { kindPrefix, limit }
    );

    return {
      success: true,
      logs,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching document audit logs:", error);
    return {
      success: false,
      error: "Failed to fetch document audit logs",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getRecentDocumentAuditEventsAction(options?: {
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
  kindPrefixes?: string[];
  limitEvents?: number;
  limitDocuments?: number;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
        ? prefixOverrideRaw.trim()
        : null;
    const effectivePrefix = prefixOverride ?? envPrefix;
    const effectiveNamespace = applyMomentGraphNamespacePrefixValue(
      baseNamespace,
      effectivePrefix
    );

    const kindPrefixesRaw = options?.kindPrefixes;
    const kindPrefixes =
      Array.isArray(kindPrefixesRaw) &&
      kindPrefixesRaw.every((s) => typeof s === "string")
        ? kindPrefixesRaw
        : ["indexing:", "synthesis:"];

    const limitEventsRaw = options?.limitEvents;
    const limitEvents =
      typeof limitEventsRaw === "number" &&
      Number.isFinite(limitEventsRaw) &&
      limitEventsRaw > 0
        ? Math.floor(limitEventsRaw)
        : 200;

    const limitDocumentsRaw = options?.limitDocuments;
    const limitDocuments =
      typeof limitDocumentsRaw === "number" &&
      Number.isFinite(limitDocumentsRaw) &&
      limitDocumentsRaw > 0
        ? Math.floor(limitDocumentsRaw)
        : 30;

    const docs = await getRecentDocumentAuditEvents(
      { env: envCloudflare, momentGraphNamespace: effectiveNamespace },
      { kindPrefixes, limitEvents, limitDocuments }
    );

    return {
      success: true,
      docs,
      kindPrefixes,
      limitEvents,
      limitDocuments,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error(
      "[actions] Error fetching recent document audit events:",
      error
    );
    return {
      success: false,
      error: "Failed to fetch recent document audit events",
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
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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

export async function getNamespaceSourceStatsAction(options?: {
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options?.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options?.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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

    const stats = await getNamespaceSourceStatsLocal(context);

    return {
      success: true,
      stats,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching namespace source stats:", error);
    return {
      success: false,
      error: "Failed to fetch namespace source stats",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getMomentsBySourceAction(options: {
  source: "github" | "discord" | "cursor" | "unknown";
  limit?: number;
  offset?: number;
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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

    const result = await getMomentsBySourceLocal(options.source, context, {
      limit: options.limit,
      offset: options.offset,
    });

    return {
      success: true,
      moments: result.moments,
      totalCount: result.totalCount,
      limit: options.limit ?? 10,
      offset: options.offset ?? 0,
      source: options.source,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching moments by source:", error);
    return {
      success: false,
      error: "Failed to fetch moments by source",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function searchMomentsByTextAction(options: {
  query: string;
  source?: "github" | "discord" | "cursor" | "unknown" | null;
  limit?: number;
  offset?: number;
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const baseNamespace = options.momentGraphNamespace ?? null;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixOverrideRaw = options.momentGraphNamespacePrefix;
    const prefixOverride =
      typeof prefixOverrideRaw === "string" &&
      prefixOverrideRaw.trim().length > 0
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

    const result = await findMomentsByTextSearchLocal(options.query, context, {
      source: options.source ?? null,
      limit: options.limit,
      offset: options.offset,
    });

    return {
      success: true,
      moments: result.moments,
      totalCount: result.totalCount,
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      query: options.query,
      source: options.source ?? null,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error searching moments by text:", error);
    return {
      success: false,
      error: "Failed to search moments",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

// Audit-specific functions moved from momentDb/index.ts

async function findMomentsByTextSearchLocal(
  searchText: string,
  context: MomentGraphContext,
  options?: {
    source?: "github" | "discord" | "cursor" | "unknown" | null;
    limit?: number;
    offset?: number;
  }
): Promise<{
  moments: Array<{
    id: string;
    documentId: string;
    title: string;
    summary: string;
    parentId?: string;
    importance?: number;
    createdAt: string;
    author: string;
  }>;
  totalCount: number;
}> {
  const db = getMomentDb(context);
  const trimmed = typeof searchText === "string" ? searchText.trim() : "";

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 50;

  const offsetRaw = options?.offset;
  const offset =
    typeof offsetRaw === "number" &&
    Number.isFinite(offsetRaw) &&
    offsetRaw >= 0
      ? Math.floor(offsetRaw)
      : 0;

  const source = options?.source ?? null;

  const sourcePrefix =
    source === "github"
      ? "github/"
      : source === "discord"
      ? "discord/"
      : source === "cursor"
      ? "cursor/"
      : null;

  let query = db
    .selectFrom("moments")
    .select([
      "id",
      "document_id",
      "summary",
      "title",
      "parent_id",
      "importance",
      "created_at",
      "author",
    ])
    .orderBy("created_at", "desc");

  // Apply filters
  if (trimmed.length > 0 || sourcePrefix || source === "unknown") {
    query = query.where((eb) => {
      const conditions: any[] = [];

      // Add source filter if provided
      if (sourcePrefix) {
        conditions.push(eb("document_id", "like", `${sourcePrefix}%`));
      } else if (source === "unknown") {
        conditions.push(
          eb.and([
            eb("document_id", "not like", "github/%"),
            eb("document_id", "not like", "discord/%"),
            eb("document_id", "not like", "cursor/%"),
          ])
        );
      }

      // Add text search if provided
      if (trimmed.length > 0) {
        const pattern = `%${trimmed}%`;
        conditions.push(
          eb.or([
            eb("title", "like", pattern),
            eb("summary", "like", pattern),
            eb("author", "like", pattern),
            eb("document_id", "like", pattern),
          ])
        );
      }

      // Combine all conditions with AND
      if (conditions.length === 1) {
        return conditions[0];
      } else if (conditions.length > 1) {
        return eb.and(conditions);
      }
      return eb.and([]);
    });
  }

  const rows = (await query
    .limit(limit)
    .offset(offset)
    .execute()) as unknown as MomentRow[];

  // Get total count with same filters
  let countQuery = db
    .selectFrom("moments")
    .select(({ fn }) => [fn.count<number>("id").as("count")]);

  if (trimmed.length > 0 || sourcePrefix || source === "unknown") {
    countQuery = countQuery.where((eb) => {
      const conditions: any[] = [];

      // Add source filter if provided
      if (sourcePrefix) {
        conditions.push(eb("document_id", "like", `${sourcePrefix}%`));
      } else if (source === "unknown") {
        conditions.push(
          eb.and([
            eb("document_id", "not like", "github/%"),
            eb("document_id", "not like", "discord/%"),
            eb("document_id", "not like", "cursor/%"),
          ])
        );
      }

      // Add text search if provided
      if (trimmed.length > 0) {
        const pattern = `%${trimmed}%`;
        conditions.push(
          eb.or([
            eb("title", "like", pattern),
            eb("summary", "like", pattern),
            eb("author", "like", pattern),
            eb("document_id", "like", pattern),
          ])
        );
      }

      // Combine all conditions with AND
      if (conditions.length === 1) {
        return conditions[0];
      } else if (conditions.length > 1) {
        return eb.and(conditions);
      }
      return eb.and([]);
    });
  }

  const totalCountResult = await countQuery.executeTakeFirst();
  const totalCount = Number(totalCountResult?.count ?? 0);

  const moments = rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    title: row.title || "Untitled",
    summary: row.summary,
    parentId: row.parent_id || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    createdAt: row.created_at,
    author: row.author,
  }));

  return {
    moments,
    totalCount,
  };
}

async function getNamespaceSourceStatsLocal(
  context: MomentGraphContext
): Promise<
  Array<{
    source: "github" | "discord" | "cursor" | "unknown";
    totalMoments: number;
    rootMoments: number;
    linkedMoments: number;
    avgImportance: number | null;
    lastUpdated: string | null;
  }>
> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("moments")
    .select(["document_id", "parent_id", "importance", "created_at"])
    .execute()) as Array<{
    document_id: string;
    parent_id: string | null;
    importance: number | null;
    created_at: string;
  }>;

  const statsBySource = new Map<
    "github" | "discord" | "cursor" | "unknown",
    {
      totalMoments: number;
      rootMoments: number;
      linkedMoments: number;
      importanceSum: number;
      importanceCount: number;
      lastUpdated: string | null;
    }
  >();

  for (const source of ["github", "discord", "cursor", "unknown"] as const) {
    statsBySource.set(source, {
      totalMoments: 0,
      rootMoments: 0,
      linkedMoments: 0,
      importanceSum: 0,
      importanceCount: 0,
      lastUpdated: null,
    });
  }

  for (const row of rows) {
    const source = parseSourceFromDocumentId(row.document_id);
    const stats = statsBySource.get(source);
    if (!stats) continue;

    stats.totalMoments += 1;
    if (row.parent_id === null) {
      stats.rootMoments += 1;
    } else {
      stats.linkedMoments += 1;
    }

    if (typeof row.importance === "number" && Number.isFinite(row.importance)) {
      stats.importanceSum += row.importance;
      stats.importanceCount += 1;
    }

    if (row.created_at) {
      if (!stats.lastUpdated || row.created_at > stats.lastUpdated) {
        stats.lastUpdated = row.created_at;
      }
    }
  }

  return Array.from(statsBySource.entries())
    .map(([source, stats]) => ({
      source,
      totalMoments: stats.totalMoments,
      rootMoments: stats.rootMoments,
      linkedMoments: stats.linkedMoments,
      avgImportance:
        stats.importanceCount > 0
          ? stats.importanceSum / stats.importanceCount
          : null,
      lastUpdated: stats.lastUpdated,
    }))
    .filter((s) => s.totalMoments > 0)
    .sort((a, b) => b.totalMoments - a.totalMoments);
}

async function getMomentsBySourceLocal(
  source: "github" | "discord" | "cursor" | "unknown",
  context: MomentGraphContext,
  options?: {
    limit?: number;
    offset?: number;
  }
): Promise<{
  moments: Array<{
    id: string;
    documentId: string;
    title: string;
    summary: string;
    parentId?: string;
    importance?: number;
    createdAt: string;
    author: string;
  }>;
  totalCount: number;
}> {
  const db = getMomentDb(context);

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 10;

  const offsetRaw = options?.offset;
  const offset =
    typeof offsetRaw === "number" &&
    Number.isFinite(offsetRaw) &&
    offsetRaw >= 0
      ? Math.floor(offsetRaw)
      : 0;

  const sourcePrefix =
    source === "github"
      ? "github/"
      : source === "discord"
      ? "discord/"
      : source === "cursor"
      ? "cursor/"
      : null;

  let query = db
    .selectFrom("moments")
    .selectAll()
    .orderBy("created_at", "desc");

  if (sourcePrefix) {
    query = query.where("document_id", "like", `${sourcePrefix}%`);
  } else if (source === "unknown") {
    query = query.where((eb) =>
      eb.and([
        eb("document_id", "not like", "github/%"),
        eb("document_id", "not like", "discord/%"),
        eb("document_id", "not like", "cursor/%"),
      ])
    );
  }

  const rows = (await query
    .limit(limit)
    .offset(offset)
    .execute()) as unknown as MomentRow[];

  const totalCountResult = await (sourcePrefix
    ? db
        .selectFrom("moments")
        .select(({ fn }) => [fn.count<number>("id").as("count")])
        .where("document_id", "like", `${sourcePrefix}%`)
        .executeTakeFirst()
    : source === "unknown"
    ? db
        .selectFrom("moments")
        .select(({ fn }) => [fn.count<number>("id").as("count")])
        .where((eb) =>
          eb.and([
            eb("document_id", "not like", "github/%"),
            eb("document_id", "not like", "discord/%"),
            eb("document_id", "not like", "cursor/%"),
          ])
        )
        .executeTakeFirst()
    : db
        .selectFrom("moments")
        .select(({ fn }) => [fn.count<number>("id").as("count")])
        .executeTakeFirst());

  const totalCount = Number(totalCountResult?.count ?? 0);

  const moments = rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    title: row.title || "Untitled",
    summary: row.summary,
    parentId: row.parent_id || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    createdAt: row.created_at,
    author: row.author,
  }));

  return {
    moments,
    totalCount,
  };
}
