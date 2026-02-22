import { Polka } from "polka";
import fs from "node:fs";
import path from "node:path";
import { state } from "../store.js";
import { getBaseUrl } from "./dtu.js";
import { config } from "../../config.js";

// Ensure DTU has a temp dir for caching
const CACHE_DIR = config.DTU_CACHE_DIR;
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function registerCacheRoutes(app: Polka) {
  // 1. Check if cache exists
  app.get("/_apis/artifactcache/caches", (req: any, res) => {
    const keys = (req.query.keys || "").split(",").map((k: string) => k.trim());
    const version = req.query.version;

    console.log(`[DTU] Checking cache for keys: ${keys.join(", ")} (version: ${version})`);

    for (const key of keys) {
      if (!key) {
        continue;
      }

      const entry = state.caches.get(key);
      if (entry && entry.version === version) {
        console.log(`[DTU] Cache hit for key: ${key}`);

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            result: "hit",
            archiveLocation: entry.archiveLocation,
            cacheKey: key,
          }),
        );
      }
    }

    console.log(`[DTU] Cache miss for keys: ${keys.join(", ")}`);
    res.writeHead(204);
    res.end();
  });

  // 2. Reserve cache space (create pending cache)
  app.post("/_apis/artifactcache/caches", (req: any, res) => {
    const { key, version } = req.body;

    console.log(`[DTU] Reserving cache for key: ${key} (version: ${version})`);

    // Assign a unique cache ID
    const cacheId = Math.floor(Math.random() * 1000000);
    const tempPath = path.join(CACHE_DIR, `temp_${cacheId}.tar.gz`);

    state.pendingCaches.set(cacheId, { tempPath, key, version });

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cacheId }));
  });

  // 3. Upload cache chunk
  app.patch("/_apis/artifactcache/caches/:cacheId", (req: any, res) => {
    const cacheId = parseInt(req.params.cacheId, 10);
    const pending = state.pendingCaches.get(cacheId);

    if (!pending) {
      console.warn(`[DTU] Cache upload to invalid ID: ${cacheId}`);
      res.writeHead(404);
      return res.end();
    }

    const contentRange = req.headers["content-range"];
    console.log(`[DTU] Uploading cache chunk to ID ${cacheId}, Content-Range: ${contentRange}`);

    // Read raw body stream
    try {
      if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
        fs.appendFileSync(pending.tempPath, req.body);
      } else {
        // body could be parsed JSON, but for octet-stream we need raw body.
        // Polk's body-parser needs to allow application/octet-stream for this route.
        // But for strings we append them.
        res.writeHead(500, { "Content-Type": "text/plain" });
        return res.end("Expected raw buffer/string body");
      }

      res.writeHead(200);
      res.end();
    } catch (e) {
      console.error("[DTU] Failed to write cache chunk:", e);
      res.writeHead(500);
      res.end();
    }
  });

  // 4. Commit cache
  app.post("/_apis/artifactcache/caches/:cacheId", (req: any, res) => {
    const cacheId = parseInt(req.params.cacheId, 10);
    const { size } = req.body || { size: 0 };
    const pending = state.pendingCaches.get(cacheId);

    if (!pending) {
      console.warn(`[DTU] Cache commit to invalid ID: ${cacheId}`);
      res.writeHead(404);
      return res.end();
    }

    console.log(`[DTU] Committing cache ID ${cacheId} (key: ${pending.key})`);

    const finalPath = path.join(CACHE_DIR, `cache_${cacheId}.tar.gz`);
    fs.renameSync(pending.tempPath, finalPath);

    const baseUrl = getBaseUrl(req);
    const archiveLocation = `${baseUrl}/_apis/artifactcache/artifacts/${cacheId}`;

    state.caches.set(pending.key, {
      version: pending.version,
      archiveLocation,
      size,
    });
    state.pendingCaches.delete(cacheId);

    res.writeHead(200);
    res.end();
  });

  // 5. Download cache archive
  app.get("/_apis/artifactcache/artifacts/:cacheId", (req: any, res) => {
    const cacheId = parseInt(req.params.cacheId, 10);
    const filePath = path.join(CACHE_DIR, `cache_${cacheId}.tar.gz`);

    if (!fs.existsSync(filePath)) {
      console.warn(`[DTU] Cache artifact not found: ${cacheId}`);
      res.writeHead(404);
      return res.end();
    }

    console.log(`[DTU] Downloading cache ID ${cacheId}`);

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="cache_${cacheId}.tar.gz"`,
      "Content-Length": fs.statSync(filePath).size,
    });

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  });
}
