import { env } from "cloudflare:workers";
import { type RequestInfo } from "rwsdk/worker";
import { getEmbedding } from "../utils/vector";

export async function searchSubjectsHandler({ request }: RequestInfo) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  try {
    const body = (await request.json()) as { query?: string };
    const queryText = body.query;

    if (!queryText || typeof queryText !== "string") {
      return Response.json({ error: "Missing or invalid 'query' parameter" }, { status: 400 });
    }

    const embedding = await getEmbedding(queryText);
    const envCloudflare = env as Cloudflare.Env;

    const results = await envCloudflare.MOMENT_INDEX.query(embedding, {
      topK: 10,
      filter: { isSubject: true },
      returnMetadata: true,
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
