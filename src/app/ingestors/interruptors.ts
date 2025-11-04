import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    INGEST_API_KEY?: string;
  }
}

export async function requireIngestApiKey({ request }: RequestInfo) {
  const apiKey = env.INGEST_API_KEY;

  if (!apiKey) {
    return Response.json(
      { error: "API key authentication not configured" },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("Authorization");
  const providedKey = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : null;

  if (!providedKey || providedKey !== apiKey) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
}
