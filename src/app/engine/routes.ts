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
import { processScannerJob } from "./services/scanner-service";

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
        message: error instanceof Error ? error.message : "Unknown error",
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
    console.log("[backfill] Starting manual backfill");
    await processScannerJob(env as Cloudflare.Env);
    console.log("[backfill] Manual backfill completed");
    return Response.json({ success: true, message: "Backfill started" });
  } catch (error) {
    console.error("[backfill] Error starting backfill:", error);
    return Response.json(
      {
        error: "Failed to start backfill",
        message: error instanceof Error ? error.message : "Unknown error",
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
