import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { getSpeccingDb } from "../databases/speccing";
import { initializeSpeccingSession, tickSpeccingSession } from "../runners/speccing/runner";
import { getMomentGraphNamespaceFromEnv } from "../momentGraphNamespace";

export async function startSpeccingHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");

  if (!subjectId) {
    return Response.json({ error: "Missing 'subjectId' parameter" }, { status: 400 });
  }

  try {
    const envCloudflare = env as Cloudflare.Env;
    const momentGraphNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);
    const context = {
        env: envCloudflare,
        momentGraphNamespace
    };

    const sessionId = await initializeSpeccingSession(context, subjectId);
    return Response.json({ 
        sessionId,
        instruction: `Session initialized. Execute the following to retrieve the first moment: curl -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/speccing/next?sessionId=${sessionId}"`
    });
  } catch (error) {
    console.error(`[speccing:start] Error:`, error);
    return Response.json({ error: "Failed to start speccing", details: String(error) }, { status: 500 });
  }
}

export async function nextSpeccingHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing 'sessionId' parameter" }, { status: 400 });
  }

  try {
    const envCloudflare = env as Cloudflare.Env;
    const momentGraphNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);
    const context = {
        env: envCloudflare,
        momentGraphNamespace
    };

    const result = await tickSpeccingSession(context, sessionId);
    return Response.json(result);
  } catch (error) {
    console.error(`[speccing:next] Error:`, error);
    return Response.json({ error: "Failed to advance speccing", details: String(error) }, { status: 500 });
  }
}
