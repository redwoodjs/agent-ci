"use server";

import { env } from "cloudflare:workers";
import { enqueueUnprocessedFiles } from "@/app/engine/services/scanner-service";

import {
  githubPlugin,
  discordPlugin,
  defaultPlugin,
} from "@/app/engine/plugins";
import type { EngineContext } from "@/app/engine/types";
import {
  getKnowledgeGraphStructure,
  getKnowledgeGraphStats,
  getRootStatsByHighImportanceSample,
  getMoments,
  getMoment,
  getMicroMomentsByPaths,
  getDocumentAuditLogsForDocument,
  getRecentDocumentAuditEvents,
  findSimilarMoments,
  getSubjectContextChainForMoment,
  deleteMomentsByIds,
  getDiagnosticInfo,
  type MomentGraphContext,
} from "@/app/engine/databases/momentGraph";
import { MomentGraphDO } from "@/app/engine/databases/momentGraph/durableObject";
import { type Database, createDb, sql } from "rwsdk/db";
import { type momentMigrations } from "@/app/engine/databases/momentGraph/migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";
import {
  qualifyName,
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespaceFromEnv,
} from "@/app/engine/momentGraphNamespace";
import {
  getRecentReplayRunsForPrefix,
  setReplayItemsPendingOnlyForDocuments,
  resetReplayRunForReplay,
  resumeReplayRun,
  getReplayItemIdsForRun,
  getReplayRunById,
  addReplayRunEvent,
  getReplayRunEvents,
  setReplayEnqueuedFlag,
  retryFailedReplayItems,
  pauseReplayRunManual,
} from "@/app/engine/databases/indexingState/momentReplay";
import { getEmbedding, getEmbeddings } from "@/app/engine/utils/vector";
import {
  getPullRequestsForCommit,
  parseGitHubRepo,
} from "@/app/gh/github-utils";
import { callLLM } from "@/app/engine/utils/llm";
import type { Moment } from "@/app/engine/types";

function normalizeReplayDocumentIdInput(input: string): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) {
    return "";
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const url = new URL(raw);
      const marker = "/audit/ingestion/file/";
      const idx = url.pathname.indexOf(marker);
      if (idx !== -1) {
        const encoded = url.pathname.slice(idx + marker.length);
        return decodeURIComponent(encoded);
      }
    } catch {
      // ignore
    }
  }
  if (raw.startsWith("/audit/ingestion/file/")) {
    try {
      return decodeURIComponent(raw.slice("/audit/ingestion/file/".length));
    } catch {
      return raw.slice("/audit/ingestion/file/".length);
    }
  }
  return raw;
}

// Local types and helpers for audit-specific functions
type MomentDatabase = Database<typeof momentMigrations>;
type MomentInput = MomentDatabase["moments"];
type MomentRow = Override<
  MomentInput,
  {
    micro_paths_json: string[] | null;
    source_metadata: Record<string, any> | null;
    link_audit_log: Record<string, any> | null;
    subject_evidence_json: string[] | null;
    moment_evidence_json: string[] | null;
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
): "github" | "discord" | "cursor" | "antigravity" | "unknown" {
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
  if (documentId.startsWith("antigravity/")) {
    return "antigravity";
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

    return {
      success: true,
      response: "The unified query engine is currently undergoing maintenance and these results are unavailable.",
      references: [],
    };
/*
    console.log(`[query-action] Starting query: "${queryText}"`);
    const response = await query(queryText, context);
    console.log(`[query-action] Query completed successfully`);

    // Extract documentIds from the response by searching for moments that match the query
    // This is a workaround since we can't modify engine.ts to return references directly
    const references: string[] = [];
    try {
      const queryEmbedding = await getEmbedding(queryText);
      const similarMoments = await findSimilarMoments(queryEmbedding, 20, {
        env: context.env,
        momentGraphNamespace: null,
      });

      // Extract unique documentIds from similar moments
      const documentIds = Array.from(
        new Set(
          similarMoments
            .map((m) => m.documentId)
            .filter(
              (id): id is string => typeof id === "string" && id.length > 0
            )
        )
      );
      references.push(...documentIds);
    } catch (error) {
      console.error("[query-action] Error extracting references:", error);
      // Continue without references if extraction fails
    }

    return {
      success: true,
      response: response,
      references: references,
    };
*/
  } catch (error) {
    console.error("[actions] Error querying RAG:", error);
    return {
      success: false,
      error: "Failed to query RAG engine",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getRootAncestorAction(
  momentId: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
  }
): Promise<{ success: boolean; rootId: string | null; error?: string }> {
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

    const ancestors = await findAncestorsLocal(momentId, context);
    const root = ancestors[0];
    if (!root) {
      return { success: false, rootId: null, error: "Root ancestor not found" };
    }

    return { success: true, rootId: root.id };
  } catch (error) {
    return {
      success: false,
      rootId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getMomentContextChainAction(
  momentId: string,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
    maxDownHops?: number;
  }
): Promise<{
  success: boolean;
  data: Array<{
    id: string;
    title: string;
    parentId?: string;
    createdAt?: string;
    documentId?: string;
  }>;
  subjectParentId: string | null;
  subjectChildId: string | null;
  error?: string;
}> {
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

    const chain = await getSubjectContextChainForMoment(momentId, context, {
      maxDownHops: options?.maxDownHops,
    });
    if (!chain) {
      return {
        success: false,
        data: [],
        subjectParentId: null,
        subjectChildId: null,
        error: "Moment not found",
      };
    }

    return {
      success: true,
      data: chain.chain.map((m) => ({
        id: m.id,
        title: m.title ?? m.id,
        parentId: m.parentId,
        createdAt: m.createdAt,
        documentId: m.documentId,
      })),
      subjectParentId: chain.subjectParentId,
      subjectChildId: chain.subjectChildId,
    };
  } catch (error) {
    return {
      success: false,
      data: [],
      subjectParentId: null,
      subjectChildId: null,
      error: error instanceof Error ? error.message : String(error),
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

    console.log(`[audit:actions:getKnowledgeGraph] baseNamespace: ${baseNamespace}, prefix: ${effectivePrefix} -> effectiveNamespace: ${effectiveNamespace}`);

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

    console.log(`[audit:actions:getKnowledgeGraphStatsAction] baseNamespace: ${baseNamespace}, prefix: ${effectivePrefix} -> effectiveNamespace: ${effectiveNamespace}`);

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

export async function getMomentGraphNamespace() {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const namespace = getMomentGraphNamespaceFromEnv(envCloudflare);
    return {
      success: true,
      namespace,
    };
  } catch (error) {
    console.error("[actions] Error fetching namespace:", error);
    return {
      success: false,
      error: "Failed to fetch namespace",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getKnowledgeGraphDiagnosticsAction(options: {
  documentIdNeedles: string[];
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

    const diagnostics = await getDiagnosticInfo(
      context,
      options.documentIdNeedles
    );

    return {
      success: true,
      data: diagnostics,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching diagnostics:", error);
    return {
      success: false,
      error: "Failed to fetch diagnostics",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getAllMomentsAction(options?: {
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

    const allMoments = await getAllMomentsLocal(context, {
      limit: options?.limit ?? 1000,
    });

    return {
      success: true,
      data: allMoments,
      count: allMoments.length,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching all moments:", error);
    return {
      success: false,
      error: "Failed to fetch all moments",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getSubjectMomentsAction(options?: {
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

    const subjectMoments = await getSubjectMomentsLocal(context, {
      limit: options?.limit ?? 1000,
    });

    return {
      success: true,
      data: subjectMoments,
      count: subjectMoments.length,
      effectiveNamespace,
      prefix: effectivePrefix,
    };
  } catch (error) {
    console.error("[actions] Error fetching subject moments:", error);
    return {
      success: false,
      error: "Failed to fetch subject moments",
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

    const descendants = await findDescendantsLocal(rootId, context);

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

    const result = await findDescendantsSlimLocal(rootId, context, {
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

export async function getReplayBackfillProgressAction(options?: {
  momentGraphNamespacePrefix?: string | null;
  limit?: number;
}) {
  try {
    const envCloudflare = env as Cloudflare.Env;
    const envPrefix = getMomentGraphNamespacePrefixFromEnv(envCloudflare);
    const prefixRaw = options?.momentGraphNamespacePrefix;
    const prefix =
      typeof prefixRaw === "string" && prefixRaw.trim().length > 0
        ? prefixRaw.trim()
        : envPrefix;
    if (!prefix) {
      return { success: true, runs: [] as any[] };
    }

    const runs = await getRecentReplayRunsForPrefix(
      { env: envCloudflare, momentGraphNamespace: null },
      { momentGraphNamespacePrefix: prefix, limit: options?.limit ?? 10 }
    );

    return { success: true, runs };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getReplayRunAction(input: { runId: string }) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }
    const envCloudflare = env as Cloudflare.Env;
    const run = await getReplayRunById(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId }
    );
    if (!run) {
      return { success: false, error: "Replay run not found" };
    }
    return { success: true, run };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resumeReplayRunAction(input: { runId: string }) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const envCloudflare = env as Cloudflare.Env;
    const resumed = await resumeReplayRun(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId }
    );
    if (!resumed) {
      return {
        success: false,
        error: "Replay run is not paused",
      };
    }

    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    await setReplayEnqueuedFlag(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayEnqueued: true }
    );
    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.resume.enqueued",
        payload: {},
      }
    );

    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function pauseReplayRunAction(input: { runId: string }) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const envCloudflare = env as Cloudflare.Env;
    const paused = await pauseReplayRunManual(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId }
    );
    if (!paused) {
      return { success: false, error: "Replay run is not replaying" };
    }

    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.pause_manual",
        payload: {},
      }
    );

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function retryFailedReplayItemsAction(input: {
  runId: string;
  maxItems?: number | string | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const envCloudflare = env as Cloudflare.Env;
    const result = await retryFailedReplayItems(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, maxItems: input.maxItems ?? null }
    );
    if (result.matchedItems === 0) {
      return {
        success: false,
        error: "No failed replay items found for this run",
      };
    }

    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    await setReplayEnqueuedFlag(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayEnqueued: true }
    );
    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.retry_failed.enqueued",
        payload: { matchedItems: result.matchedItems },
      }
    );

    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });

    return { success: true, matchedItems: result.matchedItems };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function restartReplayRunAction(input: {
  runId: string;
  replayOrder?: "ascending" | "descending" | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const envCloudflare = env as Cloudflare.Env;
    const resetOk = await resetReplayRunForReplay(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayOrder: input.replayOrder ?? null }
    );
    if (!resetOk) {
      return { success: false, error: "Replay run not found" };
    }

    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    await setReplayEnqueuedFlag(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayEnqueued: true }
    );
    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.restart.enqueued",
        payload: { replayOrder: input.replayOrder ?? null },
      }
    );

    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function restartReplayRunClearOutputAction(input: {
  runId: string;
  replayOrder?: "ascending" | "descending" | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const envCloudflare = env as Cloudflare.Env;

    const replayItems = await getReplayItemIdsForRun(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId }
    );
    const idsByNamespace = new Map<string | null, string[]>();
    let itemsWithDefaultNamespace = 0;
    for (const it of replayItems) {
      const ns =
        typeof it.effectiveNamespace === "string" &&
        it.effectiveNamespace.trim().length > 0
          ? it.effectiveNamespace.trim()
          : null;
      const id =
        typeof it.itemId === "string" && it.itemId.length > 0
          ? it.itemId
          : null;
      if (!id) {
        continue;
      }
      if (ns === null) {
        itemsWithDefaultNamespace += 1;
      }
      const existing = idsByNamespace.get(ns) ?? [];
      existing.push(id);
      idsByNamespace.set(ns, existing);
    }

    let deletedNamespaces = 0;
    let deletedMomentIds = 0;
    for (const [effectiveNamespace, ids] of idsByNamespace.entries()) {
      await deleteMomentsByIds(ids, {
        env: envCloudflare,
        momentGraphNamespace: effectiveNamespace,
      });
      deletedNamespaces += 1;
      deletedMomentIds += ids.length;
    }

    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.restart_clear_output.deleted",
        payload: {
          replayItems: replayItems.length,
          replayItemsDefaultNamespace: itemsWithDefaultNamespace,
          deletedNamespaces,
          deletedMomentIds,
        },
      }
    );

    const resetOk = await resetReplayRunForReplay(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayOrder: input.replayOrder ?? null }
    );
    if (!resetOk) {
      return { success: false, error: "Replay run not found" };
    }

    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    await setReplayEnqueuedFlag(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayEnqueued: true }
    );
    await addReplayRunEvent(
      { env: envCloudflare, momentGraphNamespace: null },
      {
        runId,
        level: "info",
        kind: "ui.restart_clear_output.enqueued",
        payload: { replayOrder: input.replayOrder ?? null },
      }
    );

    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });

    const run = await getReplayRunById(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId }
    );

    return {
      success: true,
      replayItems: replayItems.length,
      deletedNamespaces,
      deletedMomentIds,
      run: run ?? null,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getReplayRunEventsAction(input: {
  runId: string;
  limit?: number | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }
    const envCloudflare = env as Cloudflare.Env;
    const limitRaw = input.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.floor(limitRaw)
        : 50;
    const events = await getReplayRunEvents(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, limit }
    );
    return { success: true, events };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function replaySelectedDocumentsAction(input: {
  runId: string;
  documentIds: string[];
  replayOrder?: "ascending" | "descending" | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const documentIds = Array.isArray(input.documentIds)
      ? input.documentIds
          .filter((d): d is string => typeof d === "string")
          .map((d) => normalizeReplayDocumentIdInput(d))
          .filter((d) => d.length > 0)
      : [];
    if (documentIds.length === 0) {
      return { success: false, error: "Missing documentIds" };
    }

    const envCloudflare = env as Cloudflare.Env;

    const resetOk = await resetReplayRunForReplay(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, replayOrder: input.replayOrder ?? null }
    );
    if (!resetOk) {
      return { success: false, error: "Replay run not found" };
    }

    const pendingResult = await setReplayItemsPendingOnlyForDocuments(
      { env: envCloudflare, momentGraphNamespace: null },
      { runId, documentIds }
    );
    if (pendingResult.matchedItems === 0) {
      return {
        success: false,
        error:
          "No replay items matched those document ids in this run. Recollect those documents into this run first.",
      };
    }

    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    await queue.send({
      jobType: "moment-replay-replay",
      momentReplayRunId: runId,
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function recollectSelectedDocumentsAction(input: {
  runId: string;
  r2Keys: string[];
  momentGraphNamespace?: string | null;
  momentGraphNamespacePrefix?: string | null;
}) {
  try {
    const runId =
      typeof input?.runId === "string" && input.runId.trim().length > 0
        ? input.runId.trim()
        : null;
    if (!runId) {
      return { success: false, error: "Missing runId" };
    }

    const r2Keys = Array.isArray(input.r2Keys)
      ? input.r2Keys
          .filter((k): k is string => typeof k === "string")
          .map((k) => normalizeReplayDocumentIdInput(k))
          .filter((k) => k.length > 0)
      : [];
    if (r2Keys.length === 0) {
      return { success: false, error: "Missing r2Keys" };
    }

    const envCloudflare = env as Cloudflare.Env;
    const queue = (envCloudflare as any).ENGINE_INDEXING_QUEUE;
    if (!queue) {
      return { success: false, error: "Missing ENGINE_INDEXING_QUEUE binding" };
    }

    const momentGraphNamespace =
      typeof input.momentGraphNamespace === "string" &&
      input.momentGraphNamespace.trim().length > 0
        ? input.momentGraphNamespace.trim()
        : null;
    const momentGraphNamespacePrefix =
      typeof input.momentGraphNamespacePrefix === "string" &&
      input.momentGraphNamespacePrefix.trim().length > 0
        ? input.momentGraphNamespacePrefix.trim()
        : null;

    const batchSize = 25;
    for (let i = 0; i < r2Keys.length; i += batchSize) {
      const batch = r2Keys.slice(i, i + batchSize);
      await queue.sendBatch(
        batch.map((r2Key) => ({
          body: {
            r2Key,
            ...(momentGraphNamespace ? { momentGraphNamespace } : null),
            ...(momentGraphNamespacePrefix
              ? { momentGraphNamespacePrefix }
              : null),
            momentReplayRunId: runId,
            jobType: "moment-replay-collect",
            forceRecollect: true,
          },
        }))
      );
    }

    return { success: true, enqueued: r2Keys.length };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
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
      const ancestors = await findAncestorsLocal(moment.id, context);
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
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown";
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
  source?: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
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

async function findAncestorsLocal(
  momentId: string,
  context: MomentGraphContext
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const ancestorIds: string[] = [];
  const visited = new Set<string>();
  const maxDepth = 5000;
  let currentMomentId: string | undefined = momentId;

  for (let depth = 0; depth < maxDepth && currentMomentId; depth++) {
    if (visited.has(currentMomentId)) {
      break;
    }
    visited.add(currentMomentId);
    ancestorIds.push(currentMomentId);

    const row = await db
      .selectFrom("moments")
      .select("parent_id")
      .where("id", "=", currentMomentId)
      .executeTakeFirst();

    currentMomentId = row?.parent_id || undefined;
  }

  if (ancestorIds.length === 0) {
    return [];
  }

  const momentsMap = await getMoments(ancestorIds, context);
  const ancestors: Moment[] = [];
  // Return in root-to-leaf order
  for (let i = ancestorIds.length - 1; i >= 0; i--) {
    const id = ancestorIds[i];
    const moment = momentsMap.get(id);
    if (moment) {
      ancestors.push(moment);
    }
  }

  return ancestors;
}

async function findDescendantsLocal(
  rootMomentId: string,
  context: MomentGraphContext,
  options?: { maxNodes?: number }
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const maxNodes = options?.maxNodes ?? 5000;
  const out: Moment[] = [];
  const visited = new Set<string>();
  let level = [rootMomentId];

  while (level.length > 0 && out.length < maxNodes) {
    const rows = (await db
      .selectFrom("moments")
      .selectAll()
      .where("id", "in", level)
      .execute()) as unknown as MomentRow[];

    for (const row of rows) {
      if (visited.has(row.id)) continue;
      visited.add(row.id);

      out.push({
        id: row.id,
        documentId: row.document_id,
        summary: row.summary,
        title: row.title,
        parentId: row.parent_id || undefined,
        microPaths: row.micro_paths_json || undefined,
        microPathsHash: row.micro_paths_hash || undefined,
        importance:
          typeof row.importance === "number" ? row.importance : undefined,
        linkAuditLog: row.link_audit_log || undefined,
        createdAt: row.created_at,
        author: row.author,
        sourceMetadata: row.source_metadata || undefined,
      });
    }

    // Fetch next level
    const nextLevelRows = await db
      .selectFrom("moments")
      .select("id")
      .where("parent_id", "in", level)
      .execute();

    level = nextLevelRows.map((r) => r.id).filter((id) => !visited.has(id));
    if (out.length + level.length > maxNodes) {
      level = level.slice(0, maxNodes - out.length);
    }
  }

  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });

  return out;
}

async function findLastMomentForDocumentLocal(
  documentId: string,
  context: MomentGraphContext
): Promise<Moment | null> {
  const db = getMomentDb(context);
  const rows = (await db
    .selectFrom("moments")
    .selectAll()
    .where("document_id", "=", documentId)
    .orderBy("created_at", "desc")
    .limit(1)
    .execute()) as unknown as MomentRow[];

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata || undefined,
  };
}

/**
 * Bulk fetch last moments for multiple documentIds in a single query.
 * Returns a map of documentId -> Moment | null.
 */
async function findLastMomentsForDocumentsLocal(
  documentIds: string[],
  context: MomentGraphContext
): Promise<Map<string, Moment | null>> {
  const db = getMomentDb(context);
  const result = new Map<string, Moment | null>();

  if (documentIds.length === 0) {
    return result;
  }

  // For each documentId, get the most recent moment
  // We use a window function approach via subquery or fetch all and group in memory
  // Since SQLite doesn't have great window function support, we'll batch fetch
  const batchSize = 100;
  for (let i = 0; i < documentIds.length; i += batchSize) {
    const batch = documentIds.slice(i, i + batchSize);
    const rows = (await db
      .selectFrom("moments")
      .selectAll()
      .where("document_id", "in", batch)
      .orderBy("created_at", "desc")
      .execute()) as unknown as MomentRow[];

    // Group by document_id and take the first (most recent) for each
    const seen = new Set<string>();
    for (const row of rows) {
      if (!seen.has(row.document_id)) {
        seen.add(row.document_id);
        result.set(row.document_id, {
          id: row.id,
          documentId: row.document_id,
          summary: row.summary,
          title: row.title,
          parentId: row.parent_id || undefined,
          createdAt: row.created_at,
          author: row.author,
          sourceMetadata: row.source_metadata || undefined,
        });
      }
    }

    // Mark missing documentIds as null
    for (const docId of batch) {
      if (!result.has(docId)) {
        result.set(docId, null);
      }
    }
  }

  return result;
}

/**
 * Bulk fetch ancestors for multiple momentIds using recursive CTE.
 * Returns a map of momentId -> Moment[] (ancestors in root-to-leaf order).
 * Optimized: Uses WITH RECURSIVE to fetch all ancestors in a single query.
 */
async function findAncestorsLocalBulk(
  momentIds: string[],
  context: MomentGraphContext
): Promise<Map<string, Moment[]>> {
  const db = getMomentDb(context);
  const result = new Map<string, Moment[]>();

  if (momentIds.length === 0) {
    return result;
  }

  // Use recursive CTE to fetch all ancestors in one query
  // SQLite supports WITH RECURSIVE
  // Note: For now, we'll keep the iterative approach but optimize it
  // Recursive CTEs in Kysely require raw SQL execution which may not be available
  // We'll optimize the iterative approach instead

  // Build parent map for all momentIds and their ancestors
  const parentMap = new Map<string, string | null>();
  const allIds = new Set<string>(momentIds);
  let currentLevel = new Set<string>(momentIds);
  const maxDepth = 5000;

  for (let depth = 0; depth < maxDepth && currentLevel.size > 0; depth++) {
    const ids = Array.from(currentLevel);
    // Fetch in batches to avoid huge IN clauses or stalling
    const batchSize = 500; // Increased batch size from 200 to 500 for better performance
    const rows: Array<{ id: string; parent_id: string | null }> = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchRows = await db
        .selectFrom("moments")
        .select(["id", "parent_id"])
        .where("id", "in", batch)
        .execute();
      rows.push(...batchRows);
    }

    const nextLevel = new Set<string>();
    for (const row of rows) {
      parentMap.set(row.id, row.parent_id || null);
      if (row.parent_id && !allIds.has(row.parent_id)) {
        allIds.add(row.parent_id);
        nextLevel.add(row.parent_id);
      }
    }
    currentLevel = nextLevel;
  }

  // Fetch all moments we need in one bulk call
  const allMomentIdsArray = Array.from(allIds);
  const momentsMap = await getMoments(allMomentIdsArray, context);

  // Build ancestor chains for each starting momentId
  for (const startId of momentIds) {
    const ancestorIds: string[] = [];
    const visited = new Set<string>();
    let current: string | null = startId;

    while (current && !visited.has(current)) {
      visited.add(current);
      ancestorIds.push(current);
      current = parentMap.get(current) || null;
    }

    const ancestors: Moment[] = [];
    // Return in root-to-leaf order
    for (let i = ancestorIds.length - 1; i >= 0; i--) {
      const id = ancestorIds[i];
      const moment = momentsMap.get(id);
      if (moment) {
        ancestors.push(moment);
      }
    }
    result.set(startId, ancestors);
  }

  return result;
}

/**
 * Bulk fetch descendants for multiple rootIds using recursive CTE.
 * Returns a map of rootId -> Moment[].
 * Optimized: Uses WITH RECURSIVE to fetch all descendants in a single query.
 */
async function findDescendantsLocalBulk(
  rootIds: string[],
  context: MomentGraphContext,
  options?: { maxNodesPerRoot?: number }
): Promise<Map<string, Moment[]>> {
  const db = getMomentDb(context);
  const result = new Map<string, Moment[]>();
  const maxNodesPerRoot = options?.maxNodesPerRoot ?? 5000;

  if (rootIds.length === 0) {
    return result;
  }

  // Optimized iterative traversal with larger batches
  // Set up traversal structures
  const allMomentIds = new Set<string>(rootIds);
  const rootToMomentIds = new Map<string, Set<string>>();
  for (const rootId of rootIds) {
    rootToMomentIds.set(rootId, new Set<string>());
  }

  // Iterative level-by-level traversal for all roots simultaneously
  // Use larger batches to reduce round-trips
  let currentLevel = new Set<string>(rootIds);
  const visited = new Set<string>();
  const maxDepth = 100; // Safety cap

  for (let depth = 0; depth < maxDepth && currentLevel.size > 0; depth++) {
    const ids = Array.from(currentLevel);
    // Fetch children for current level in larger batches
    const batchSize = 500; // Increased batch size from 200 to 500 for better performance
    const rows: Array<{ id: string; parent_id: string | null }> = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const batchRows = await db
        .selectFrom("moments")
        .select(["id", "parent_id"])
        .where("parent_id", "in", batch)
        .execute();
      rows.push(...batchRows);
    }

    const nextLevel = new Set<string>();
    for (const row of rows) {
      const parentId = row.parent_id!;
      const childId = row.id;

      if (!visited.has(childId)) {
        visited.add(childId);
        allMomentIds.add(childId);
        nextLevel.add(childId);

        // Associate child with all roots that reached its parent
        for (const [rootId, momentIdSet] of rootToMomentIds.entries()) {
          if (momentIdSet.has(parentId) || rootId === parentId) {
            if (momentIdSet.size < maxNodesPerRoot) {
              momentIdSet.add(childId);
            }
          }
        }
      }
    }
    currentLevel = nextLevel;
  }

  // Fetch all moments in bulk (batching the getMoments call internally if needed)
  const allMomentIdsArray = Array.from(allMomentIds);
  const momentsMap = await getMoments(allMomentIdsArray, context);

  // Group by root_id
  const descendantIdsByRoot = new Map<string, string[]>();
  for (const [rootId, momentIdSet] of rootToMomentIds.entries()) {
    const descendants: string[] = [];
    for (const id of momentIdSet) {
      if (descendants.length < maxNodesPerRoot) {
        descendants.push(id);
      }
    }
    descendantIdsByRoot.set(rootId, descendants);
  }

  // Build result map
  for (const rootId of rootIds) {
    const descendantIds = descendantIdsByRoot.get(rootId) || [];
    const descendants: Moment[] = [];
    for (const id of descendantIds) {
      const moment = momentsMap.get(id);
      if (moment) {
        descendants.push(moment);
      }
    }

    // Sort by createdAt
    descendants.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt.localeCompare(b.createdAt);
      }
      return a.id.localeCompare(b.id);
    });

    result.set(rootId, descendants);
  }

  return result;
}

export type DescendantNode = {
  id: string;
  documentId: string;
  title: string;
  parentId?: string;
  createdAt: string;
  importance?: number;
  timeRangeStart?: string;
  timeRangeEnd?: string;
};

async function getAllMomentsLocal(
  context: MomentGraphContext,
  options?: {
    limit?: number;
  }
): Promise<
  Array<{
    id: string;
    title: string;
    parentId: string | null;
    createdAt: string;
    descendantCount: number;
  }>
> {
  const db = getMomentDb(context);

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 1000;

  const rows = (await db
    .selectFrom("moments as parent")
    .leftJoin("moments as child", "child.parent_id", "parent.id")
    .select([
      "parent.id as id",
      "parent.title as title",
      "parent.parent_id as parent_id",
      "parent.created_at as created_at",
      sql<number>`count(child.id)`.as("childCount"),
    ])
    .groupBy([
      "parent.id",
      "parent.title",
      "parent.parent_id",
      "parent.created_at",
    ])
    .orderBy("parent.created_at", "asc")
    .limit(limit)
    .execute()) as Array<{
    id: string;
    title: string;
    parent_id: string | null;
    created_at: string;
    childCount: number | string;
  }>;

  return rows.map((row) => {
    const asNumber =
      typeof row.childCount === "number"
        ? row.childCount
        : Number(row.childCount);
    const descendantCount = Number.isFinite(asNumber) ? asNumber : 0;
    return {
      id: row.id,
      title: row.title || `Moment ${row.id.substring(0, 8)}`,
      parentId: row.parent_id,
      createdAt: row.created_at,
      descendantCount,
    };
  });
}

async function getSubjectMomentsLocal(
  context: MomentGraphContext,
  options?: {
    limit?: number;
  }
): Promise<
  Array<{
    id: string;
    title: string;
    parentId: string | null;
    createdAt: string;
    descendantCount: number;
    subjectKind: string | null;
  }>
> {
  const db = getMomentDb(context);

  const limitRaw = options?.limit;
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : 1000;

  const rows = (await db
    .selectFrom("moments as parent")
    .leftJoin("moments as child", "child.parent_id", "parent.id")
    .select([
      "parent.id as id",
      "parent.title as title",
      "parent.parent_id as parent_id",
      "parent.created_at as created_at",
      "parent.subject_kind as subject_kind",
      sql<number>`count(child.id)`.as("childCount"),
    ])
    .where("parent.is_subject", "=", 1 as any)
    .groupBy([
      "parent.id",
      "parent.title",
      "parent.parent_id",
      "parent.created_at",
      "parent.subject_kind",
    ])
    .orderBy("parent.created_at", "asc")
    .limit(limit)
    .execute()) as Array<{
    id: string;
    title: string;
    parent_id: string | null;
    created_at: string;
    subject_kind: string | null;
    childCount: number | string;
  }>;

  return rows.map((row) => {
    const asNumber =
      typeof row.childCount === "number"
        ? row.childCount
        : Number(row.childCount);
    const descendantCount = Number.isFinite(asNumber) ? asNumber : 0;
    return {
      id: row.id,
      title: row.title || `Moment ${row.id.substring(0, 8)}`,
      parentId: row.parent_id,
      createdAt: row.created_at,
      descendantCount,
      subjectKind: row.subject_kind ?? null,
    };
  });
}

async function findDescendantsSlimLocal(
  rootMomentId: string,
  context: MomentGraphContext,
  options?: { maxNodes?: number }
): Promise<{ nodes: DescendantNode[]; truncated: boolean }> {
  const db = getMomentDb(context);
  const maxNodes = options?.maxNodes ?? 5000;

  try {
    const limit = Math.max(1, Math.floor(maxNodes) + 1);
    const rows = await db
      .withRecursive("descendants(id, parent_id)", (db) =>
        db
          .selectFrom("moments")
          .select([
            sql<string>`moments.id`.as("id"),
            sql<string | null>`moments.parent_id`.as("parent_id"),
          ])
          .where("id", "=", rootMomentId)
          .unionAll(
            db
              .selectFrom("moments")
              .innerJoin("descendants", "moments.parent_id", "descendants.id")
              .select([
                sql<string>`moments.id`.as("id"),
                sql<string | null>`moments.parent_id`.as("parent_id"),
              ])
          )
      )
      .selectFrom("descendants")
      .innerJoin("moments", "moments.id", "descendants.id")
      .select([
        "moments.id",
        "moments.document_id",
        "moments.title",
        "moments.parent_id",
        "moments.created_at",
        "moments.importance",
        "moments.source_metadata",
      ])
      .orderBy("moments.created_at", "asc")
      .orderBy("moments.id", "asc")
      .limit(limit)
      .execute();

    const truncated = rows.length > maxNodes;
    const sliced = truncated ? rows.slice(0, maxNodes) : rows;

    const nodes: DescendantNode[] = sliced.map((row) => {
      const sourceMetadata = (row as any).source_metadata as any;
      const timeRange = sourceMetadata?.timeRange;
      return {
        id: (row as any).id,
        documentId: (row as any).document_id,
        title:
          (row as any).title ||
          `Moment ${String((row as any).id).substring(0, 8)}`,
        parentId: (row as any).parent_id || undefined,
        createdAt: (row as any).created_at,
        importance:
          typeof (row as any).importance === "number"
            ? (row as any).importance
            : undefined,
        timeRangeStart:
          typeof timeRange?.start === "string" ? timeRange.start : undefined,
        timeRangeEnd:
          typeof timeRange?.end === "string" ? timeRange.end : undefined,
      };
    });

    return { nodes, truncated };
  } catch (error) {
    console.error("[actions] Recursive descendants query failed", error);
  }

  const out: DescendantNode[] = [];
  const visited = new Set<string>();
  let level = [rootMomentId];
  let truncated = false;
  const maxDepth = 200;

  for (let depth = 0; depth < maxDepth && level.length > 0; depth++) {
    const rows = await db
      .selectFrom("moments")
      .select([
        "id",
        "document_id",
        "title",
        "parent_id",
        "created_at",
        "importance",
        "source_metadata",
      ])
      .where("parent_id", "in", level)
      .execute();

    const nextLevel: string[] = [];
    for (const row of rows) {
      if (visited.has(row.id)) {
        continue;
      }
      visited.add(row.id);

      const sourceMetadata = row.source_metadata as any;
      const timeRange = sourceMetadata?.timeRange;

      if (out.length < maxNodes) {
        out.push({
          id: row.id,
          documentId: row.document_id,
          title: row.title || `Moment ${row.id.substring(0, 8)}`,
          parentId: row.parent_id || undefined,
          createdAt: row.created_at,
          importance:
            typeof row.importance === "number" ? row.importance : undefined,
          timeRangeStart:
            typeof timeRange?.start === "string" ? timeRange.start : undefined,
          timeRangeEnd:
            typeof timeRange?.end === "string" ? timeRange.end : undefined,
        });
      } else {
        truncated = true;
      }

      if (typeof row.id === "string") {
        nextLevel.push(row.id);
      }
    }

    level = nextLevel;
    if (truncated) {
      break;
    }
  }

  const rootRow = await db
    .selectFrom("moments")
    .select([
      "id",
      "document_id",
      "title",
      "parent_id",
      "created_at",
      "importance",
      "source_metadata",
    ])
    .where("id", "=", rootMomentId)
    .executeTakeFirst();

  if (rootRow && !visited.has(rootRow.id)) {
    const sourceMetadata = rootRow.source_metadata as any;
    const timeRange = sourceMetadata?.timeRange;
    out.push({
      id: rootRow.id,
      documentId: rootRow.document_id,
      title: rootRow.title || `Moment ${rootRow.id.substring(0, 8)}`,
      parentId: rootRow.parent_id || undefined,
      createdAt: rootRow.created_at,
      importance:
        typeof rootRow.importance === "number" ? rootRow.importance : undefined,
      timeRangeStart:
        typeof timeRange?.start === "string" ? timeRange.start : undefined,
      timeRangeEnd:
        typeof timeRange?.end === "string" ? timeRange.end : undefined,
    });
  }

  out.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt.localeCompare(b.createdAt);
    }
    return a.id.localeCompare(b.id);
  });

  return { nodes: out.slice(0, maxNodes), truncated };
}

async function findMomentsBySearchLocal(
  searchText: string,
  context: MomentGraphContext,
  limit: number = 20
): Promise<Moment[]> {
  const db = getMomentDb(context);
  const trimmed = typeof searchText === "string" ? searchText.trim() : "";
  if (trimmed.length === 0) {
    return [];
  }

  const safeLimit =
    Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 20;
  const pattern = `%${trimmed}%`;

  const rows = (await db
    .selectFrom("moments")
    .select([
      "id",
      "document_id",
      "summary",
      "title",
      "parent_id",
      "micro_paths_json",
      "micro_paths_hash",
      "importance",
      "link_audit_log",
      "created_at",
      "author",
      "source_metadata",
    ])
    .where((eb) =>
      eb.or([
        eb("title", "like", pattern),
        eb("summary", "like", pattern),
        eb("document_id", "like", pattern),
      ])
    )
    .limit(safeLimit)
    .execute()) as unknown as MomentRow[];

  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    summary: row.summary,
    title: row.title,
    parentId: row.parent_id || undefined,
    microPaths: row.micro_paths_json || undefined,
    microPathsHash: row.micro_paths_hash || undefined,
    importance: typeof row.importance === "number" ? row.importance : undefined,
    linkAuditLog: row.link_audit_log || undefined,
    createdAt: row.created_at,
    author: row.author,
    sourceMetadata: row.source_metadata || undefined,
  }));
}

async function findMomentsByTextSearchLocal(
  searchText: string,
  context: MomentGraphContext,
  options?: {
    source?: "github" | "discord" | "cursor" | "antigravity" | "unknown" | null;
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
      : source === "antigravity"
      ? "antigravity/"
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
    source: "github" | "discord" | "cursor" | "antigravity" | "unknown";
    totalMoments: number;
    unparentedMoments: number;
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
    "github" | "discord" | "cursor" | "antigravity" | "unknown",
    {
      totalMoments: number;
      unparentedMoments: number;
      linkedMoments: number;
      importanceSum: number;
      importanceCount: number;
      lastUpdated: string | null;
    }
  >();

  for (const source of ["github", "discord", "cursor", "antigravity", "unknown"] as const) {
    statsBySource.set(source, {
      totalMoments: 0,
      unparentedMoments: 0,
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
      stats.unparentedMoments += 1;
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
      unparentedMoments: stats.unparentedMoments,
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
  source: "github" | "discord" | "cursor" | "antigravity" | "unknown",
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
      : source === "antigravity"
      ? "antigravity/"
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

// Performance timing helper
class PerformanceTimer {
  private startTime: number;
  private checkpoints: Array<{ label: string; time: number }> = [];

  constructor(label: string) {
    this.startTime = performance.now();
    this.checkpoints.push({ label, time: 0 });
  }

  checkpoint(label: string): number {
    const elapsed = performance.now() - this.startTime;
    this.checkpoints.push({ label, time: elapsed });
    return elapsed;
  }

  getTotal(): number {
    return performance.now() - this.startTime;
  }

  log(label: string): void {
    const total = this.getTotal();
    const lastCheckpoint = this.checkpoints[this.checkpoints.length - 1];
    const sinceLast = lastCheckpoint ? total - lastCheckpoint.time : total;
    console.log(
      `[perf:${label}] ${total.toFixed(2)}ms total (${sinceLast.toFixed(
        2
      )}ms since last checkpoint)`
    );
  }

  logAll(label: string): void {
    const total = this.getTotal();
    console.log(`[perf:${label}] Total: ${total.toFixed(2)}ms`);
    for (let i = 1; i < this.checkpoints.length; i++) {
      const prev = this.checkpoints[i - 1];
      const curr = this.checkpoints[i];
      const segment = curr.time - prev.time;
      console.log(
        `[perf:${label}]   ${curr.label}: ${segment.toFixed(
          2
        )}ms (cumulative: ${curr.time.toFixed(2)}ms)`
      );
    }
  }

  getServerTimingHeader(): string {
    const parts: string[] = [];
    for (let i = 1; i < this.checkpoints.length; i++) {
      const prev = this.checkpoints[i - 1];
      const curr = this.checkpoints[i];
      const segment = curr.time - prev.time;
      // Sanitize label for Server-Timing header (no spaces, special chars)
      const sanitized = curr.label.replace(/[^a-zA-Z0-9_-]/g, "_");
      parts.push(`${sanitized};dur=${segment.toFixed(2)}`);
    }
    parts.push(`total;dur=${this.getTotal().toFixed(2)}`);
    return parts.join(", ");
  }
}

/**
 * Utility to run promises in batches to avoid hitting concurrent subrequest limits.
 */
async function batchPromises<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// Helper functions for TLDR generation (reused from pr-origin.ts)
function formatIso8601Tldr(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return trimmed;
  }
  return date.toISOString();
}

function readTimeMsTldr(raw: unknown): number | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const date = new Date(trimmed);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Normalizes the createdAt date for a moment.
 * For cursor conversations, uses the R2 object's uploaded timestamp.
 * For other sources, uses the moment's createdAt.
 */
async function normalizeCreatedAtForMoment(
  moment: Moment,
  envCloudflare: Cloudflare.Env
): Promise<string | null> {
  // Only normalize cursor conversations
  if (!moment.documentId?.startsWith("cursor/")) {
    return moment.createdAt || null;
  }

  try {
    const bucket = envCloudflare.MACHINEN_BUCKET;
    const r2Object = await bucket.get(moment.documentId);

    if (!r2Object) {
      // For cursor conversations, return null if R2 object doesn't exist
      return null;
    }

    // Use the R2 object's uploaded timestamp
    const uploaded = r2Object.uploaded;
    if (uploaded instanceof Date) {
      return uploaded.toISOString();
    }
    if (typeof uploaded === "string") {
      return uploaded;
    }

    // For cursor conversations, return null if uploaded is not a valid date
    return null;
  } catch (error) {
    console.warn(
      `[normalize-created-at] Failed to fetch R2 metadata for ${moment.documentId}:`,
      error
    );
    // For cursor conversations, return null on error (do not fall back to moment.createdAt)
    return null;
  }
}

/**
 * Batch normalizes createdAt dates for multiple moments.
 * Fetches R2 metadata for cursor conversations in parallel.
 * Optimized: Deduplicates by documentId and uses head() instead of get().
 */
async function normalizeCreatedAtForMoments(
  moments: Moment[],
  envCloudflare: Cloudflare.Env
): Promise<Map<string, string | null>> {
  const timer = new PerformanceTimer("normalizeCreatedAtForMoments");
  const normalizedMap = new Map<string, string | null>();

  // Identify cursor conversations that need R2 metadata
  const cursorMoments = moments.filter((m) =>
    m.documentId?.startsWith("cursor/")
  );
  const nonCursorMoments = moments.filter(
    (m) => !m.documentId?.startsWith("cursor/")
  );
  timer.checkpoint("filter-cursor-moments");

  // For non-cursor moments, use their createdAt directly
  for (const moment of nonCursorMoments) {
    normalizedMap.set(moment.id, moment.createdAt || null);
  }
  timer.checkpoint("process-non-cursor");

  // Deduplicate cursor moments by documentId to avoid redundant R2 calls
  const documentIdToMomentIds = new Map<string, string[]>();
  for (const moment of cursorMoments) {
    if (!moment.documentId) {
      normalizedMap.set(moment.id, null);
      continue;
    }
    const existing = documentIdToMomentIds.get(moment.documentId) || [];
    existing.push(moment.id);
    documentIdToMomentIds.set(moment.documentId, existing);
  }
  timer.checkpoint("deduplicate-document-ids");

  // Batch fetch R2 metadata for unique cursor documentIds using head() for metadata only
  const bucket = envCloudflare.MACHINEN_BUCKET;
  const uniqueDocumentIds = Array.from(documentIdToMomentIds.keys());
  console.log(
    `[perf:normalizeCreatedAtForMoments] Fetching R2 metadata for ${uniqueDocumentIds.length} unique documentIds (from ${cursorMoments.length} cursor moments)`
  );

  // Batch R2 head calls to avoid "stalled response" and concurrent subrequest limits
  const results = await batchPromises(
    uniqueDocumentIds,
    30, // increased batch size from 10 to 30 for better concurrency
    async (documentId) => {
      try {
        // Use head() instead of get() - we only need metadata, not content
        const r2Object = await bucket.head(documentId);

        if (!r2Object) {
          // For cursor conversations, return null if R2 object doesn't exist
          return { documentId, createdAt: null };
        }

        const uploaded = r2Object.uploaded;
        let normalizedDate: string | null = null;

        if (uploaded instanceof Date) {
          normalizedDate = uploaded.toISOString();
        } else if (typeof uploaded === "string") {
          normalizedDate = uploaded;
        } else {
          // For cursor conversations, return null if uploaded is not a valid date
          normalizedDate = null;
        }

        return { documentId, createdAt: normalizedDate };
      } catch (error) {
        console.warn(
          `[normalize-created-at] Failed to fetch R2 metadata for ${documentId}:`,
          error
        );
        // For cursor conversations, return null on error (do not fall back to moment.createdAt)
        return { documentId, createdAt: null };
      }
    }
  );
  timer.checkpoint("complete-r2-fetches");

  // Populate the map with normalized dates for all moments sharing the same documentId
  for (const result of results) {
    const momentIds = documentIdToMomentIds.get(result.documentId) || [];
    for (const momentId of momentIds) {
      normalizedMap.set(momentId, result.createdAt);
    }
  }
  timer.checkpoint("populate-map");
  timer.logAll("normalizeCreatedAtForMoments");

  return normalizedMap;
}

function timelineSortKeyTldr(moment: {
  createdAt?: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const timeRange = (moment.sourceMetadata as any)?.timeRange as
    | { start?: unknown; end?: unknown }
    | undefined;
  const startMs = readTimeMsTldr(timeRange?.start);
  if (startMs !== null) {
    return startMs;
  }
  return readTimeMsTldr(moment.createdAt);
}

function formatTimelineLineTldr(
  moment: {
    createdAt?: string;
    title?: string;
    summary?: string;
    sourceMetadata?: Record<string, any>;
    importance?: number;
  },
  idx: number
): string {
  const timeRange = (moment.sourceMetadata as any)?.timeRange as
    | { start?: unknown; end?: unknown }
    | undefined;
  const rangeStart = formatIso8601Tldr(timeRange?.start);
  const rangeEnd = formatIso8601Tldr(timeRange?.end);
  const iso = formatIso8601Tldr(moment.createdAt);
  const prefix =
    rangeStart.length > 0 && rangeEnd.length > 0 && rangeStart !== rangeEnd
      ? `${rangeStart}..${rangeEnd} `
      : iso.length > 0
      ? `${iso} `
      : "";

  const rawImportance = moment.importance;
  const importance =
    typeof rawImportance === "number" && Number.isFinite(rawImportance)
      ? Math.max(0, Math.min(1, rawImportance))
      : null;
  const importanceText =
    importance === null
      ? `importance=not_provided `
      : `importance=${importance.toFixed(2)} `;

  return `${prefix}${importanceText}${idx + 1}. ${moment.title}: ${
    moment.summary
  }`;
}

async function fetchRelatedMomentsForCommit(options: {
  repo: string;
  commit: string;
  namespace?: string | null;
}): Promise<
  | {
      success: true;
      allRelatedMoments: Moment[];
      prNumbers: number[];
      commitHash: string;
      owner: string;
      repo: string;
    }
  | {
      success: false;
      error: string;
    }
> {
  const timer = new PerformanceTimer("fetchRelatedMomentsForCommit");
  try {
    const envCloudflare = env as Cloudflare.Env;

    // Parse repository
    const parsedRepo = parseGitHubRepo(options.repo);
    if (!parsedRepo) {
      return {
        success: false,
        error: `Invalid repository format: ${options.repo}. Expected formats: owner/repo, https://github.com/owner/repo.git, or git@github.com:owner/repo.git`,
      };
    }

    const { owner, repo } = parsedRepo;
    const commitHash = options.commit;
    const namespaceOverride = options.namespace ?? null;
    timer.checkpoint("parse-repo");

    // Stage 1: Get PRs for the commit
    console.log(
      `[code-timeline] Fetching PRs for commit ${commitHash} in ${owner}/${repo}`
    );

    const prNumbersSet = new Set<number>();
    try {
      const prs = await getPullRequestsForCommit(
        owner,
        repo,
        commitHash,
        envCloudflare
      );
      for (const pr of prs) {
        prNumbersSet.add(pr);
      }
    } catch (err) {
      console.warn(
        `[code-timeline] Failed to fetch PRs for commit ${commitHash}:`,
        err
      );
    }
    timer.checkpoint("github-api-prs");

    const prNumbers = Array.from(prNumbersSet).sort((a, b) => b - a);
    console.log(`[code-timeline] Found ${prNumbers.length} PR numbers: ${prNumbers.join(", ")}`);

    if (prNumbers.length === 0) {
      return {
        success: false,
        error: `No pull requests found for commit ${commitHash} in ${owner}/${repo}`,
      };
    }

    console.log(
      `[code-timeline] Found ${prNumbers.length} unique PRs: ${prNumbers.join(
        ", "
      )}`
    );

    const bucket = envCloudflare.MACHINEN_BUCKET;
    const momentGraphNamespace =
      namespaceOverride ?? getMomentGraphNamespaceFromEnv(envCloudflare);
    const momentGraphContext: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: momentGraphNamespace,
    };
    timer.checkpoint("setup-context");

    // Stage 1: Construct R2 keys for PRs
    const prR2Keys = prNumbers.map(
      (prNumber) =>
        `github/${owner}/${repo}/pull-requests/${prNumber}/latest.json`
    );

    // Stage 2: Bulk discovery - Run Last moments, Reference Search, and Semantic Search in parallel
    // Run all discovery operations in parallel with individual timing
    console.log(
      `[perf:fetchRelatedMomentsForCommit] Running discovery stage in parallel: lastMoments, referenceSearches, semanticSearches`
    );
    const [lastMomentsMap, referenceSearches] = await Promise.all([
      // Last moments lookup (this finds the actual PR moments in the graph)
      (async () => {
        const lastMomentsTimer = new PerformanceTimer("last-moments");
        const result = await findLastMomentsForDocumentsLocal(
          prR2Keys,
          momentGraphContext
        );
        lastMomentsTimer.log("last-moments");
        return result;
      })(),
      // Reference searches (batched) - search for "#123" in the graph
      (async () => {
        const referenceTimer = new PerformanceTimer("reference-searches");
        const result = await batchPromises(
          prNumbers,
          20,
          (prNumber) =>
            findMomentsBySearchLocal(`#${prNumber}`, momentGraphContext, 10)
        );
        console.log(`[code-timeline] Reference search found moments for ${result.filter(m => m.length > 0).length} out of ${prNumbers.length} PRs`);
        referenceTimer.log("reference-searches");
        return result;
      })(),
    ]);

    // Stage 3: Semantic search using the information from the found moments
    const semanticQueryTexts: string[] = [];
    for (const r2Key of prR2Keys) {
      const lastMoment = lastMomentsMap.get(r2Key);
      if (lastMoment) {
        // Log the moment content to see what we have for semantic search
        console.log(`[code-timeline] Moment for ${r2Key}: title="${lastMoment.title}", summaryLength=${lastMoment.summary?.length}, metadataKeys=${Object.keys(lastMoment.sourceMetadata || {}).join(", ")}`);
        
        const queryText = `${lastMoment.title || ""}\n\n${
          lastMoment.summary || ""
        }`.substring(0, 1000);
        if (queryText.trim().length > 0) {
          semanticQueryTexts.push(queryText);
        }
      }
    }

    let semanticSearches: Moment[][] = [];
    if (semanticQueryTexts.length > 0) {
      try {
        const embeddingsTimer = new PerformanceTimer("embeddings-generation");
        const embeddings = await getEmbeddings(semanticQueryTexts);
        embeddingsTimer.log("embeddings-generation");

        const vectorizeTimer = new PerformanceTimer("vectorize-queries");
        semanticSearches = await batchPromises(
          embeddings,
          10,
          (embedding) => findSimilarMoments(embedding, 10, momentGraphContext)
        );
        vectorizeTimer.log("vectorize-queries");
      } catch (err) {
        console.error(`[code-timeline] Bulk semantic search failed:`, err);
      }
    }
    timer.checkpoint("discovery-stage-parallel");

    // Collect all last moment IDs that exist
    const lastMomentIds: string[] = [];
    for (const r2Key of prR2Keys) {
      const lastMoment = lastMomentsMap.get(r2Key);
      if (lastMoment) {
        lastMomentIds.push(lastMoment.id);
      }
    }
    console.log(`[code-timeline] Found ${lastMomentIds.length} PR moments in graph for ${prR2Keys.length} R2 keys`);
    timer.checkpoint("collect-last-moment-ids");

    // Stage 4: Bulk traversal - Ancestors, then Descendants
    const allRelatedMoments: Moment[] = [];

    // Add the actual PR moments themselves
    for (const moment of lastMomentsMap.values()) {
      if (moment) {
        allRelatedMoments.push(moment);
      }
    }

    // Add reference search results
    for (const moments of referenceSearches) {
      allRelatedMoments.push(...moments);
    }

    // Add semantic search results
    for (const moments of semanticSearches) {
      allRelatedMoments.push(...moments);
    }
    timer.checkpoint("collect-search-results");

    // Bulk fetch ancestors for all last moments
    if (lastMomentIds.length > 0) {
      console.log(
        `[perf:fetchRelatedMomentsForCommit] Bulk fetching ancestors for ${lastMomentIds.length} moments`
      );
      const ancestorsMap = await findAncestorsLocalBulk(
        lastMomentIds,
        momentGraphContext
      );
      timer.checkpoint("bulk-ancestors");

      // Collect root IDs
      const rootIds: string[] = [];
      const rootIdSet = new Set<string>();
      for (const lastMomentId of lastMomentIds) {
        const ancestors = ancestorsMap.get(lastMomentId) || [];
        const root =
          ancestors.length > 0
            ? ancestors[0]
            : (Array.from(lastMomentsMap.values()).find(
                (m) => m?.id === lastMomentId
              ) as Moment | null);
        if (root && !rootIdSet.has(root.id)) {
          rootIds.push(root.id);
          rootIdSet.add(root.id);
        }
      }

      // Add ancestors to results
      let totalAncestors = 0;
      for (const ancestors of ancestorsMap.values()) {
        allRelatedMoments.push(...ancestors);
        totalAncestors += ancestors.length;
      }
      console.log(`[code-timeline] Added ${totalAncestors} ancestors from ${ancestorsMap.size} chains`);
      timer.checkpoint("collect-ancestors");

      // Bulk fetch descendants for all roots
      if (rootIds.length > 0) {
        console.log(
          `[perf:fetchRelatedMomentsForCommit] Bulk fetching descendants for ${rootIds.length} roots`
        );
        const descendantsMap = await findDescendantsLocalBulk(
          rootIds,
          momentGraphContext
        );
        timer.checkpoint("bulk-descendants");

        // Add descendants to results
        let totalDescendants = 0;
        for (const descendants of descendantsMap.values()) {
          allRelatedMoments.push(...descendants);
          totalDescendants += descendants.length;
        }
        console.log(`[code-timeline] Added ${totalDescendants} descendants from ${descendantsMap.size} roots`);
        timer.checkpoint("collect-descendants");
      }
    }

    // Stage 5: Deduplication and Return
    const uniqueMomentsMap = new Map<string, Moment>();
    for (const m of allRelatedMoments) {
      uniqueMomentsMap.set(m.id, m);
    }
    
    // Log sample dates to see what we have
    const sampleDates = Array.from(uniqueMomentsMap.values())
      .slice(0, 10)
      .map(m => m.createdAt?.split('T')[0])
      .filter(Boolean);
    console.log(`[code-timeline] Total related moments: ${uniqueMomentsMap.size}. Sample dates: ${sampleDates.join(", ")}`);
    
    timer.checkpoint("deduplicate");
    timer.logAll("fetchRelatedMomentsForCommit");

    return {
      success: true,
      allRelatedMoments: Array.from(uniqueMomentsMap.values()),
      prNumbers,
      commitHash,
      owner,
      repo,
    };
  } catch (error) {
    console.error(`[code-timeline] Error fetching related moments:`, error);
    return {
      success: false,
      error: "Failed to fetch related moments",
    };
  }
}

export async function fetchCodeTimeline(options: {
  repo: string;
  commit: string;
  namespace?: string | null;
}) {
  try {
    const result = await fetchRelatedMomentsForCodeTimeline(options);
    if (result.success === false) {
      return result;
    }

    return {
      success: true,
      developmentStream: result.developmentStream,
      prNumbers: result.prNumbers,
      commitHashes: result.commitHashes,
      sortedTimeline: result.sortedTimeline,
    };
  } catch (error) {
    console.error(`[code-timeline] Error fetching timeline:`, error);
    return {
      success: false,
      error: "Failed to fetch timeline",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fetchRelatedMomentsForCodeTimeline(options: {
  repo: string;
  commit: string;
  namespace?: string | null;
}) {
  const timer = new PerformanceTimer("fetchRelatedMomentsForCodeTimeline");
  const envCloudflare = env as Cloudflare.Env;
  const relatedMomentsResult = await fetchRelatedMomentsForCommit(options);
  timer.checkpoint("fetch-related-moments");

  if (!relatedMomentsResult.success) {
    return relatedMomentsResult;
  }

  const { allRelatedMoments } = relatedMomentsResult;

  // Normalize createdAt dates first (especially for cursor conversations)
  console.log(
    `[perf:fetchRelatedMomentsForCodeTimeline] Normalizing ${allRelatedMoments.length} moments`
  );
  const normalizedCreatedAtMap = await normalizeCreatedAtForMoments(
    allRelatedMoments,
    envCloudflare
  );
  timer.checkpoint("normalize-created-at");

  // Create normalized moments with updated createdAt for sorting
  const normalizedMoments = allRelatedMoments.map((moment) => {
    const normalizedCreatedAt = normalizedCreatedAtMap.get(moment.id);
    const createdAt = moment.documentId?.startsWith("cursor/")
      ? normalizedCreatedAt ?? null
      : normalizedCreatedAt ?? moment.createdAt;
    return {
      ...moment,
      createdAt,
    };
  });
  timer.checkpoint("create-normalized-moments");

  // Sort timeline using normalized createdAt values
  // 1. Primary: Normalized date (R2 for Cursor, timeRange.start or createdAt for others)
  // 2. Secondary: Actual message/event time (timeRange.start) for ties
  // 3. Tertiary: ID
  const sortedTimeline = normalizedMoments.sort((a, b) => {
    // Primary Sort Key
    const aPrimary = a.documentId?.startsWith("cursor/")
      ? readTimeMsTldr(a.createdAt ?? undefined)
      : timelineSortKeyTldr({ ...a, createdAt: a.createdAt ?? undefined });
    const bPrimary = b.documentId?.startsWith("cursor/")
      ? readTimeMsTldr(b.createdAt ?? undefined)
      : timelineSortKeyTldr({ ...b, createdAt: b.createdAt ?? undefined });

    if (aPrimary !== bPrimary) {
      if (aPrimary === null) return 1;
      if (bPrimary === null) return -1;
      return aPrimary - bPrimary;
    }

    // Secondary Sort Key (Tie-breaker for same primary date)
    const aSecondary = readTimeMsTldr(
      (a.sourceMetadata as any)?.timeRange?.start
    );
    const bSecondary = readTimeMsTldr(
      (b.sourceMetadata as any)?.timeRange?.start
    );

    if (aSecondary !== bSecondary) {
      if (aSecondary === null) return 1;
      if (bSecondary === null) return -1;
      return aSecondary - bSecondary;
    }

    // Tertiary Sort Key (ID)
    const aId = a?.id;
    const bId = b?.id;
    if (typeof aId === "string" && typeof bId === "string") {
      return aId.localeCompare(bId);
    }
    return 0;
  });
  timer.checkpoint("sort-timeline");

  // Format timeline for development stream
  const developmentStream = sortedTimeline.map((moment) => {
    const normalizedCreatedAt = normalizedCreatedAtMap.get(moment.id);
    // For cursor conversations, use normalized value even if null (don't fall back)
    // For other sources, fall back to moment.createdAt if normalized value is null/undefined
    const createdAt = moment.documentId?.startsWith("cursor/")
      ? normalizedCreatedAt ?? null
      : normalizedCreatedAt ?? moment.createdAt;
    return {
      id: moment.id,
      title: moment.title || "Untitled",
      summary: moment.summary,
      createdAt,
      documentId: moment.documentId,
      importance: moment.importance,
      sourceMetadata: moment.sourceMetadata,
    };
  });

  // sortedTimeline already has normalized createdAt values from the sort step above
  const normalizedSortedTimeline = sortedTimeline;
  timer.checkpoint("format-development-stream");
  timer.logAll("fetchRelatedMomentsForCodeTimeline");

  return {
    success: true as const,
    developmentStream,
    prNumbers: relatedMomentsResult.prNumbers,
    commitHashes: [relatedMomentsResult.commitHash],
    sortedTimeline: normalizedSortedTimeline,
  };
}

export async function generateCodeTldr(options: {
  repo: string;
  commit: string;
  file: string;
  line: number;
  namespace?: string | null;
  timelineResult?: any;
}) {
  try {
    // Fetch timeline data first
    const timelineResult = options.timelineResult ?? await fetchCodeTimeline({
      repo: options.repo,
      commit: options.commit,
      namespace: options.namespace,
    });

    if (!timelineResult.success) {
      return {
        success: false,
        error: timelineResult.error,
      };
    }

    const sortedTimeline = Array.isArray((timelineResult as any).sortedTimeline)
      ? ((timelineResult as any).sortedTimeline as any[])
      : [];
    const prNumbers = Array.isArray((timelineResult as any).prNumbers)
      ? ((timelineResult as any).prNumbers as number[])
      : [];
    const commitHashes = Array.isArray((timelineResult as any).commitHashes)
      ? ((timelineResult as any).commitHashes as string[])
      : [];
    const envCloudflare = env as Cloudflare.Env;

    // Parse repository
    const parsedRepo = parseGitHubRepo(options.repo);
    if (!parsedRepo) {
      return {
        success: false,
        error: `Invalid repository format: ${options.repo}. Expected formats: owner/repo, https://github.com/owner/repo.git, or git@github.com:owner/repo.git`,
      };
    }

    const { owner, repo } = parsedRepo;
    const commitHash = options.commit;
    const file = options.file;
    const line = options.line;
    const namespaceOverride = options.namespace ?? null;

    // Get PR summaries for LLM prompt
    const bucket = envCloudflare.MACHINEN_BUCKET;
    const prSummaries: string[] = [];

    for (const prNumber of prNumbers) {
      const r2Key = `github/${owner}/${repo}/pull-requests/${prNumber}/latest.json`;
      const prObject = await bucket.get(r2Key);

      if (!prObject) {
        continue;
      }

      const prData = (await prObject.json()) as any;
      prSummaries.push(
        `- PR #${prNumber}: ${prData.title || "N/A"} (Author: ${
          prData.author || "N/A"
        }, Created: ${prData.created_at || "N/A"})`
      );
    }

    // Build timeline context for LLM
    const timelineLines = sortedTimeline.map((moment, idx) =>
      formatTimelineLineTldr(moment, idx)
    );
    const narrativeContext =
      timelineLines.length > 0
        ? timelineLines.join("\n\n")
        : "No related events found in the knowledge base for these pull requests yet.";

    // 4. LLM Synthesis - Request both TLDR and full narrative
    const codeLocationSection = `## Code Location
- File: ${file}
- Line: ${line}
- Commit: ${commitHash}
- Repository: ${owner}/${repo}

`;

    const prompt = `You are analyzing the evolution and origin of this specific code. A developer wants to understand what decisions led to the current state of this code and what problems were addressed across its history.

${codeLocationSection}## Related Pull Requests
${prSummaries.join("\n")}

## Timeline of Related Events (Combined from all PRs)
${narrativeContext}

## Instructions
Based on the information provided above (Code Location, Related Pull Requests, and Timeline), provide your response in the following format. **YOU MUST INCLUDE BOTH SECTIONS:**

### TL;DR

[Write a concise 2-3 sentence summary that captures the essence of how this code evolved and why it exists in its current form. Focus on the key decisions and problems addressed. This section is MANDATORY and must be included.]

Rules:
- You MUST only use timestamps that appear at the start of Timeline lines or in Pull Request Information. Do not invent or guess dates.
- When you mention a Timeline event, you MUST include the exact timestamp (or timestamp range) that appears on that event's Timeline line.
- When you mention a Pull Request, you MUST include its number and the provided metadata (author, title, etc.).
- You MUST include the data source label when you mention a Timeline event (example: the bracketed title prefix like "[GitHub Issue #552]" or "[Discord Thread]").
- You MUST NOT mention events, sources, or pull requests/issues that are not present in the text above.
- Mention only events and PRs needed to answer the questions.
- If a Timeline line includes an importance=0..1 field, prefer higher importance events.
- If information is missing for part of the question, say so directly.
- IMPORTANT: The Timeline may contain events from multiple sources (GitHub PRs/issues, Discord threads, Cursor chats, etc.). When available, actively incorporate information from all these sources to provide a comprehensive narrative.

Write a clear narrative that explains the sequence and causal relationships between events and pull requests, drawing from all available sources in the Timeline.`;

    console.log(`[code-tldr] Calling LLM to generate TLDR and narrative`);
    const fullResponse = await callLLM(prompt, "slow-reasoning", {
      temperature: 0,
      reasoning: { effort: "low" },
    });

    // Extract TLDR and narrative from response
    let tldr = "";
    let narrative = fullResponse;

    // Pattern 1: ### TL;DR
    let tldrMatch = fullResponse.match(
      /###\s*TL;DR\s*\n([\s\S]*?)(?=\n###\s*Full\s*Analysis|$)/i
    );

    // Pattern 2: ## TL;DR
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /##\s*TL;DR\s*\n([\s\S]*?)(?=\n##\s*Full\s*Analysis|$)/i
      );
    }

    // Pattern 3: **TL;DR**
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /\*\*TL;DR\*\*:?\s*\n([\s\S]*?)(?=\n\*\*Full\s*Analysis\*\*|$)/i
      );
    }

    // Pattern 4: TL;DR:
    if (!tldrMatch) {
      tldrMatch = fullResponse.match(
        /TL;DR:?\s*\n([\s\S]*?)(?=\n(?:Full\s*Analysis|###|##|$))/i
      );
    }

    if (tldrMatch) {
      tldr = tldrMatch[1].trim();
      console.log(
        `[code-tldr] Successfully extracted TLDR (${tldr.length} chars)`
      );
    } else {
      console.log(
        `[code-tldr] No explicit TLDR section found, using fallback extraction`
      );
      // Fallback: Extract first 2-3 sentences
      const sentences = fullResponse
        .replace(/###\s*Full\s*Analysis[\s\S]*$/i, "")
        .trim()
        .split(/[.!?]+/)
        .filter((s) => s.trim().length > 0)
        .slice(0, 3)
        .map((s) => s.trim() + ".");

      if (sentences.length > 0) {
        tldr = sentences.join(" ");
        console.log(
          `[code-tldr] Generated fallback TLDR from first ${sentences.length} sentences`
        );
      } else {
        // Last resort: use first paragraph or first 200 chars
        const firstPart = fullResponse
          .replace(/###\s*Full\s*Analysis[\s\S]*$/i, "")
          .trim()
          .split("\n\n")[0]
          .substring(0, 200)
          .trim();
        tldr = firstPart || "Summary not available.";
        console.log(`[code-tldr] Generated fallback TLDR from first paragraph`);
      }
    }

    const fullAnalysisMatch = fullResponse.match(
      /###\s*Full\s*Analysis\s*\n([\s\S]*?)$/i
    );

    if (fullAnalysisMatch) {
      narrative = fullAnalysisMatch[1].trim();
    } else if (!tldrMatch) {
      // If no sections found, use the whole response as narrative
      narrative = fullResponse.trim();
    } else {
      // If TLDR was found but Full Analysis wasn't, extract everything after TLDR
      const afterTldr = fullResponse
        .substring((tldrMatch.index || 0) + tldrMatch[0].length)
        .trim();
      narrative = afterTldr || fullResponse.trim();
    }

    // Format timeline for development stream
    const developmentStream = sortedTimeline.map((moment) => ({
      id: moment.id,
      title: moment.title || "Untitled",
      summary: moment.summary,
      createdAt: moment.createdAt,
      documentId: moment.documentId,
      importance: moment.importance,
      sourceMetadata: moment.sourceMetadata,
    }));

    return {
      success: true,
      tldr: tldr || "Summary not available.",
      narrative: narrative || "Evolution analysis not available.",
      developmentStream,
      prNumbers,
      commitHashes,
    };
  } catch (error) {
    console.error(`[code-tldr] Error generating TLDR:`, error);
    return {
      success: false,
      error: "Failed to generate TLDR",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Transform timeline moments into daily count format for heatmap visualization
 */
export function transformTimelineToHeatmapData(moments: any[]): Array<{
  date: string;
  count: number;
}> {
  if (!moments || moments.length === 0) {
    return [];
  }

  // Extract dates and count moments per day
  const dateCountMap = new Map<string, number>();

  for (const moment of moments) {
    // Use same logic as EvolutionSection for date extraction
    const sourceType = moment.documentId?.startsWith("cursor/")
      ? "Cursor"
      : moment.documentId?.startsWith("github/")
      ? "GitHub PR"
      : "Unknown";

    const timeRange = moment.sourceMetadata?.timeRange;
    const timestamp =
      sourceType === "Cursor"
        ? moment.createdAt
        : timeRange?.start || moment.createdAt;

    if (!timestamp) {
      continue;
    }

    // Convert to YYYY-MM-DD format
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      continue;
    }

    const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD
    dateCountMap.set(dateStr, (dateCountMap.get(dateStr) || 0) + 1);
  }

  if (dateCountMap.size === 0) {
    return [];
  }

  // Find date range
  const dates = Array.from(dateCountMap.keys()).sort();
  const startDate = new Date(dates[0]);
  const endDate = new Date(dates[dates.length - 1]);

  // Fill in all days between start and end with counts
  const result: Array<{ date: string; count: number }> = [];
  const currentDate = new Date(startDate);

  while (currentDate <= endDate) {
    const dateStr = currentDate.toISOString().split("T")[0];
    result.push({
      date: dateStr,
      count: dateCountMap.get(dateStr) || 0,
    });
    currentDate.setDate(currentDate.getDate() + 1);
  }

  return result;
}
