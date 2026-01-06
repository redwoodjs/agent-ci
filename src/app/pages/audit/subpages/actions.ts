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
} from "@/app/engine/momentDb";
import {
  getMomentGraphNamespacePrefixFromEnv,
  applyMomentGraphNamespacePrefixValue,
} from "@/app/engine/momentGraphNamespace";

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
