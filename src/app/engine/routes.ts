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
];
