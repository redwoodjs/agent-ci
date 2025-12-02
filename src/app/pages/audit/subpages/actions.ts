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
