import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { getSpeccingDb } from "../databases/speccing";
import { initializeSpeccingSession, tickSpeccingSession, tickSpeccingSessionStream, type SpeccingSessionResult } from "../runners/speccing/runner";
import { getMomentGraphNamespaceFromEnv, applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";
import { type MomentGraphContext } from "../databases/momentGraph";
import { createEngineContext } from "../index";

export async function startSpeccingHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subjectId");

  if (!subjectId) {
    return Response.json({ error: "Missing 'subjectId' parameter" }, { status: 400 });
  }

  try {
    const envCloudflare = env as Cloudflare.Env;
    let momentGraphNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);

    // Dynamic Resolution via Plugins
    const body = (await request.json().catch(() => ({}))) as {
      revisionMode?: "server" | "client";
      context?: {
        repository?: string;
        namespacePrefix?: string;
      };
    };

    const revisionMode = body.revisionMode || "server";

    if (body.context) {
       const engineContext = createEngineContext(envCloudflare, "querying");
       const queryContext = {
        query: "speccing-init", // Dummy query for context
        env: envCloudflare,
        clientContext: body.context
      };
      
      for (const plugin of engineContext.plugins) {
        if (plugin.scoping?.computeMomentGraphNamespaceForQuery) {
          const ns = await plugin.scoping.computeMomentGraphNamespaceForQuery(queryContext);
          if (ns) {
            momentGraphNamespace = ns;
            break;
          }
        }
      }
      
      if (body.context.namespacePrefix && momentGraphNamespace) {
        momentGraphNamespace = applyMomentGraphNamespacePrefixValue(momentGraphNamespace, body.context.namespacePrefix);
      }
      if (momentGraphNamespace) {
        console.log(`[speccing:start] Resolved dynamic namespace: ${momentGraphNamespace}`);
      }
    }

    const context = {
        env: envCloudflare,
        momentGraphNamespace
    };

    const sessionId = await initializeSpeccingSession(context, subjectId, revisionMode);
    return Response.json({ 
        sessionId,
        instruction: `SESSION INITIALIZED: 1. Following the protocol in .agent/rules/machinen.md, prepare to iteratively update the technical specification in docs/specs/. 2. Execute the first turn: curl -H "Authorization: Bearer $API_KEY" "$WORKER_URL/api/speccing/next?sessionId=${sessionId}"`
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
    // Context only needs env here; runner will re-hydrate momentGraphNamespace from DB
    const body = (await request.json().catch(() => ({}))) as {
      userPrompt?: string;
    };

    const context: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace: null,
    };

    const result = await tickSpeccingSession(context, sessionId, body.userPrompt);
    return Response.json(result);
  } catch (error) {
    console.error(`[speccing:next] Error:`, error);
    return Response.json({ error: "Failed to advance speccing", details: String(error) }, { status: 500 });
  }
}
export async function nextSpeccingStreamHandler({ request }: RequestInfo) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId) {
    return Response.json({ error: "Missing 'sessionId' parameter" }, { status: 400 });
  }

  try {
    const envCloudflare = env as Cloudflare.Env;
    const body = (await request.json().catch(() => ({}))) as {
      userPrompt?: string;
    };

    const momentGraphNamespace = getMomentGraphNamespaceFromEnv(envCloudflare);
    const context: MomentGraphContext = {
      env: envCloudflare,
      momentGraphNamespace,
    };

    return await tickSpeccingSessionStream(context, sessionId, body.userPrompt);
  } catch (error) {
    console.error(`[speccing:next:stream] Error:`, error);
    return Response.json({ error: "Failed to stream speccing", details: String(error) }, { status: 500 });
  }
}
