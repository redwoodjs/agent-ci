import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { getSpeccingDb } from "../databases/speccing";
import { initializeSpeccingSession, tickSpeccingSession, type SpeccingSessionResult } from "../runners/speccing/runner";
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
      context?: {
        repository?: string;
        namespacePrefix?: string;
      }
    };

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
    // Context only needs env here; runner will re-hydrate momentGraphNamespace from DB
    const context: MomentGraphContext = {
        env: envCloudflare,
        momentGraphNamespace: null,
    };

    const result = await tickSpeccingSession(context, sessionId);
    return Response.json(result);
  } catch (error) {
    console.error(`[speccing:next] Error:`, error);
    return Response.json({ error: "Failed to advance speccing", details: String(error) }, { status: 500 });
  }
}
