import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { getEmbedding } from "../utils/vector";
import { createEngineContext } from "../index";
import { applyMomentGraphNamespacePrefixValue } from "../momentGraphNamespace";

export async function searchSubjectsHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { 
      query?: string;
      context?: {
        repository?: string;
        namespacePrefix?: string;
      }
    };
    const queryText = body.query;

    if (!queryText || typeof queryText !== "string") {
      return Response.json({ error: "Missing or invalid 'query' parameter" }, { status: 400 });
    }

    const envCloudflare = env as Cloudflare.Env;
    const engineContext = createEngineContext(envCloudflare, "querying");
    
    // Resolve base namespace from plugins
    let baseNamespace = null;
    if (body.context) {
      const queryContext = {
        query: queryText,
        env: envCloudflare,
        clientContext: body.context
      };
      
      for (const plugin of engineContext.plugins) {
        if (plugin.scoping?.computeMomentGraphNamespaceForQuery) {
          const ns = await plugin.scoping.computeMomentGraphNamespaceForQuery(queryContext);
          if (ns) {
            baseNamespace = ns;
            break;
          }
        }
      }
    }

    // Apply simulation prefix if provided
    let finalNamespace = baseNamespace;
    if (body.context?.namespacePrefix && baseNamespace) {
        finalNamespace = applyMomentGraphNamespacePrefixValue(baseNamespace, body.context.namespacePrefix);
    }

    const filter: any = { isSubject: true };
    if (finalNamespace) {
        filter.momentGraphNamespace = finalNamespace;
        console.log(`[subjects:search] querying namespace: ${finalNamespace}`);
    }

    const embedding = await getEmbedding(queryText);

    console.log(`[subjects:search] Querying Vectorize with topK=10. Namespace Filter: ${finalNamespace || "none"}`);
    
    let results = await envCloudflare.MOMENT_INDEX.query(embedding, {
      topK: 10,
      filter,
      returnMetadata: true,
    });

    if (results.matches.length === 0 && finalNamespace) {
      console.warn(`[subjects:search] No matches found in namespace ${finalNamespace}. Retrying without namespace filter...`);
      results = await envCloudflare.MOMENT_INDEX.query(embedding, {
        topK: 5,
        filter: { isSubject: true },
        returnMetadata: true,
      });
    }

    console.log(`[subjects:search] Found ${results.matches.length} matches.`);
    results.matches.forEach((m, i) => {
      console.log(`  [${i}] score=${m.score.toFixed(4)} id=${m.id} title=${(m.metadata as any)?.documentTitle} ns=${(m.metadata as any)?.momentGraphNamespace}`);
    });

    const matches = results.matches.map((match) => ({
      id: match.id,
      score: match.score,
      title: (match.metadata as any)?.documentTitle ?? "Untitled",
      summary: (match.metadata as any)?.summary ?? "",
      namespace: (match.metadata as any)?.momentGraphNamespace ?? "default",
    }));

    return Response.json({ matches });
  } catch (error) {
    console.error(`[subjects:search] Error:`, error);
    return Response.json({ error: "Failed to search subjects", details: String(error) }, { status: 500 });
  }
}
