import { type RequestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    API_KEY?: string;
  }
}

export async function requireQueryApiKey({ request }: RequestInfo) {
  const url = new URL(request.url);
  const isLocalhost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1";
  if (isLocalhost) {
    return;
  }

  const apiKey = (env as any).API_KEY;

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

const requestCounts = new Map<string, { count: number; resetTime: number }>();

export async function rateLimitQuery({
  request,
  ctx,
}: RequestInfo & { ctx?: any }) {
  const apiKey = request.headers.get("Authorization")?.slice(7) || "anonymous";
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 20;

  const key = `rag-query:${apiKey}`;
  const current = requestCounts.get(key);

  if (!current || now > current.resetTime) {
    requestCounts.set(key, { count: 1, resetTime: now + windowMs });
    return ctx;
  }

  if (current.count >= maxRequests) {
    return Response.json(
      { error: "Rate limit exceeded. Maximum 20 requests per minute." },
      { status: 429 }
    );
  }

  current.count++;
  return ctx;
}

export async function validateQueryInput({
  request,
  ctx,
}: RequestInfo & { ctx?: any }) {
  const url = new URL(request.url);
  const queryParam = url.searchParams.get("q");

  let queryText: string | null = queryParam;

  if (request.method === "POST") {
    try {
      const body = (await request.json()) as { query?: string };
      queryText = body.query || queryParam;
      ctx.parsedBody = body;
    } catch {
      queryText = queryParam;
    }
  }

  if (!queryText || typeof queryText !== "string") {
    return Response.json(
      { error: "Missing 'query' parameter" },
      { status: 400 }
    );
  }

  if (queryText.length > 1000) {
    return Response.json(
      { error: "Query too long. Maximum 1000 characters." },
      { status: 400 }
    );
  }

  if (queryText.length < 3) {
    return Response.json(
      { error: "Query too short. Minimum 3 characters." },
      { status: 400 }
    );
  }

  ctx.validatedQuery = queryText;
  return ctx;
}
