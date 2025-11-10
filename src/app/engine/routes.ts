import { route } from "rwsdk/router";
import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { query } from "./engine";
import { githubPlugin } from "./plugins";
import type { EngineContext } from "./types";

async function queryHandler({ request }: RequestInfo) {
  const body = await request.json().catch(() => ({}));
  const queryText = body.query || new URL(request.url).searchParams.get("q");

  if (!queryText || typeof queryText !== "string") {
    return Response.json(
      { error: "Missing 'query' parameter" },
      { status: 400 }
    );
  }

  const context: EngineContext = {
    plugins: [githubPlugin],
    env: env as Cloudflare.Env,
  };

  try {
    const response = await query(queryText, context);
    return Response.json({ response });
  } catch (error) {
    console.error("[query-api] Error processing query:", error);
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
  route("/query", { post: queryHandler, get: queryHandler }),
];
