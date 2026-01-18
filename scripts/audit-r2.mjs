import { env } from "cloudflare:workers";

export default {
  async fetch(request) {
    const bucket = env.MACHINEN_BUCKET;
    if (!bucket) {
      return Response.json({ error: "No bucket" });
    }

    const prefixes = ["", "github/", "discord/", "cursor/"];
    const results = {};

    for (const p of prefixes) {
      const res = await bucket.list({ prefix: p, limit: 100 });
      results[p || "root"] = res.objects.map(o => o.key);
    }

    return Response.json(results);
  }
}
