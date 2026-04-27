import type { RouteMiddleware } from "rwsdk/router";

/**
 * Parse an Accept header and decide whether the client is asking for
 * markdown in preference to HTML. Rules:
 *
 *   - The client must explicitly list `text/markdown`. A bare `*\/*` is
 *     treated as "browser default" — HTML wins.
 *   - If both `text/markdown` and `text/html` are listed, higher q-value
 *     wins. A tie still returns true (agent opted in explicitly).
 *   - Malformed q-values fall back to q=1.0 per RFC 9110 §12.5.1.
 *
 * This conservative default keeps browsers on HTML (they don't list
 * text/markdown) and flips to markdown only when an agent sends an
 * explicit signal, matching Cloudflare's "Markdown for Agents" semantics.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) {
    return false;
  }
  type Entry = { type: string; q: number };
  const entries: Entry[] = accept.split(",").map((raw) => {
    const parts = raw.trim().split(";");
    const type = (parts[0] ?? "").trim().toLowerCase();
    let q = 1.0;
    for (const p of parts.slice(1)) {
      const m = p.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (m) {
        const parsed = Number.parseFloat(m[1]!);
        q = Number.isFinite(parsed) ? parsed : 1.0;
      }
    }
    return { type, q };
  });
  const md = entries.find((e) => e.type === "text/markdown");
  if (!md) {
    return false;
  }
  const html = entries.find((e) => e.type === "text/html");
  if (!html) {
    return true;
  }
  return md.q >= html.q;
}

/**
 * Factory that returns a route-level middleware: on matching routes, if
 * the client prefers markdown, respond with the given markdown body and
 * short-circuit the downstream component. Otherwise return undefined so
 * the component renders as normal.
 *
 * The middleware sets `Vary: Accept` so caches (including Cloudflare's)
 * key the response by the Accept header.
 */
export function serveMarkdownIfPreferred(body: string): RouteMiddleware {
  return ({ request, response }) => {
    if (!prefersMarkdown(request.headers.get("accept"))) {
      return;
    }
    // Tell caches that the body depends on Accept. Append to any existing
    // Vary the response might already have accumulated.
    const existingVary = response.headers.get("Vary");
    const varyValue = existingVary ? `${existingVary}, Accept` : "Accept";
    return new Response(body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        Vary: varyValue,
      },
    });
  };
}
