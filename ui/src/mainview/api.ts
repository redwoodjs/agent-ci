const API_BASE = "http://localhost:8912";

/**
 * Shared fetch wrapper with consistent error handling.
 * All API calls should go through this instead of raw `fetch()`.
 *
 * - Prefixes paths with the API base URL
 * - Checks response status and logs errors
 * - Returns typed JSON responses
 * - Throws on network errors with context
 */
export async function api<T = any>(path: string, options?: RequestInit): Promise<T> {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const method = options?.method?.toUpperCase() ?? "GET";

  let res: Response;
  try {
    res = await fetch(url, options);
  } catch (err) {
    const msg = `[Machinen] Network error: ${method} ${path}`;
    console.error(msg, err);
    throw new Error(msg);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = `[Machinen] API error: ${method} ${path} → ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`;
    console.error(msg);
    throw new Error(msg);
  }

  // Some endpoints return empty bodies (204, etc.)
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return res.json() as Promise<T>;
  }
  return undefined as unknown as T;
}

/**
 * Convenience: POST JSON to an API endpoint.
 */
export async function apiPost<T = any>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Convenience: PUT JSON to an API endpoint.
 */
export async function apiPut<T = any>(path: string, body: unknown): Promise<T> {
  return api<T>(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Convenience: DELETE with optional JSON body.
 */
export async function apiDelete<T = any>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method: "DELETE",
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
}
