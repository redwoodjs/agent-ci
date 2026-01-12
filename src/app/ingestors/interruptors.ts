import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    INGEST_API_KEY?: string;
    API_KEY?: string;
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

export const requireBasicAuth = async ({ request }: { request: Request }) => {
  // Check for api_key query parameter first (for VS Code extension webviews)
  const url = new URL(request.url);
  const apiKeyParam = url.searchParams.get("api_key");

  if (apiKeyParam) {
    if (apiKeyParam !== env.API_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    // Valid api_key, allow request
    return;
  }

  // Fall back to basic authentication
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Audit Area"' },
    });
  }
  const [type, credentials] = authHeader.split(" ");
  if (type !== "Basic") {
    return new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Audit Area"' },
    });
  }
  const [username, password] = atob(credentials).split(":");
  if (username !== "admin" || password !== env.API_KEY) {
    return new Response(null, {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Audit Area"' },
    });
  }
};
