import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import {
  requireQueryApiKey,
  rateLimitQuery,
  validateQueryInput,
} from "./interruptors";
import { query } from "./engine";
import { githubPlugin, defaultPlugin } from "./plugins";
import type { EngineContext } from "./types";
import {
  processScannerJob,
  scanForUnprocessedFiles,
  enqueueUnprocessedFiles,
} from "./services/scanner-service";

async function queryHandler({ request, ctx }: RequestInfo) {
  const queryText =
    (ctx as any).validatedQuery ||
    ((ctx as any).parsedBody as { query?: string })?.query ||
    new URL(request.url).searchParams.get("q");

  if (!queryText) {
    return Response.json(
      { error: "Missing 'query' parameter" },
      { status: 400 }
    );
  }

  const context: EngineContext = {
    plugins: [githubPlugin, defaultPlugin],
    env: env as Cloudflare.Env,
  };

  try {
    console.log(`[query] Starting query: "${queryText}"`);
    const response = await query(queryText, context);
    console.log(`[query] Query completed successfully`);
    return Response.json({ response });
  } catch (error) {
    console.error("[query] Error processing query:", error);
    return Response.json(
      {
        error: "Failed to process query",
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
    let body: { prefix?: string; r2Keys?: string[] } = {};
    try {
      body = (await request.json()) as { prefix?: string; r2Keys?: string[] };
    } catch {
      body = {};
    }

    const envCloudflare = env as Cloudflare.Env;

    if (body.r2Keys && Array.isArray(body.r2Keys)) {
      console.log(
        `[backfill] Indexing ${body.r2Keys.length} specific R2 keys directly`
      );
      await enqueueUnprocessedFiles(body.r2Keys, envCloudflare);
      return Response.json({
        success: true,
        message: `Enqueued ${body.r2Keys.length} files for indexing`,
      });
    }

    const prefix = body.prefix || "github/";
    console.log(`[backfill] Starting manual backfill for prefix: ${prefix}`);

    const unprocessedKeys = await scanForUnprocessedFiles(
      envCloudflare,
      prefix
    );

    if (unprocessedKeys.length > 0) {
      await enqueueUnprocessedFiles(unprocessedKeys, envCloudflare);
      console.log(
        `[backfill] Manual backfill completed. Enqueued ${unprocessedKeys.length} files.`
      );
      return Response.json({
        success: true,
        message: `Backfill completed. Enqueued ${unprocessedKeys.length} files for indexing.`,
        filesEnqueued: unprocessedKeys.length,
      });
    } else {
      console.log(`[backfill] Manual backfill completed. No files to index.`);
      return Response.json({
        success: true,
        message: "Backfill completed. No files need indexing.",
        filesEnqueued: 0,
      });
    }
  } catch (error) {
    console.error("[backfill] Error starting backfill:", error);
    return Response.json(
      {
        error: "Failed to start backfill",
      },
      { status: 500 }
    );
  }
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
  route("/admin/backfill", {
    post: [requireQueryApiKey, backfillHandler],
  }),
];
