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

/** Append a cache event to cache-events.json in every active runner's log dir. */
function recordCacheEvent(result: "hit" | "miss", key: string) {
  const event = { key, result, ts: Date.now() };
  for (const dir of state.runnerTimelineDirs.values()) {
    const filePath = path.join(dir, "cache-events.json");
    try {
      let existing: any[] = [];
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        /* file doesn't exist yet */
      }
      existing.push(event);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    } catch {
      /* best-effort */
    }
  }
}

export function registerCacheRoutes(app: Polka) {
  // 1. Check if cache exists
  const checkCacheHandler = (req: any, res: any) => {
    const keys = (req.query.keys || "").split(",").map((k: string) => k.trim());
    const version = req.query.version;

    console.log(`[DTU] Checking cache for keys: ${keys.join(", ")} (version: ${version})`);

    for (const key of keys) {
      if (!key) {
        continue;
      }

      const entry = state.caches.get(key);
      if (entry && entry.version === version) {
        // Validate archive file still exists on disk
        const cacheIdMatch = entry.archiveLocation.match(/artifacts\/(\d+)/);
        if (cacheIdMatch) {
          const filePath = path.join(CACHE_DIR, `cache_${cacheIdMatch[1]}.tar.gz`);
          if (!fs.existsSync(filePath)) {
            console.warn(`[DTU] Evicting stale cache "${key}" — file missing: ${filePath}`);
            state.caches.delete(key);
            state.saveCachesToDisk();
            continue;
          }
        }

        console.log(`[DTU] Cache hit for key: ${key}`);
        recordCacheEvent("hit", key);

        // Construct archiveLocation dynamically from the current request so stale
        // hostnames persisted in caches.json don't cause download failures.
        const archiveLocation = cacheIdMatch
          ? `${getBaseUrl(req)}/_apis/artifactcache/artifacts/${cacheIdMatch[1]}`
          : entry.archiveLocation;

        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            result: "hit",
            archiveLocation,
            cacheKey: key,
          }),
        );
      }
    }

    console.log(`[DTU] Cache miss for keys: ${keys.join(", ")}`);
    recordCacheEvent("miss", keys.filter(Boolean).join(","));
    res.writeHead(204);
    res.end();
  };

  app.get("/_apis/artifactcache/caches", checkCacheHandler);
  app.get("/_apis/artifactcache/cache", checkCacheHandler);

  // 2. Reserve cache space (create pending cache)
  app.post("/_apis/artifactcache/caches", (req: any, res) => {
    const { key, version } = req.body;

    console.log(`[DTU] Reserving cache for key: ${key} (version: ${version})`);

    // Immutable: reject if this key+version is already cached
    const existing = state.caches.get(key);
    if (existing && existing.version === version) {
      console.log(`[DTU] Cache already exists for key: ${key} — skipping reservation`);
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Cache already exists" }));
    }

    // Assign a unique cache ID
    const cacheId = Math.floor(Math.random() * 1000000);
    const tempPath = path.join(CACHE_DIR, `temp_${cacheId}.tar.gz`);

    fs.writeFileSync(tempPath, ""); // create an empty file
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

    let startOffset = -1;
    if (contentRange && typeof contentRange === "string") {
      const match = contentRange.match(/bytes (\d+)-/);
      if (match) {
        startOffset = parseInt(match[1], 10);
      }
    }

    try {
      if (Buffer.isBuffer(req.body) || typeof req.body === "string") {
        const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);

        if (startOffset >= 0) {
          const fd = fs.openSync(pending.tempPath, "r+");
          fs.writeSync(fd, buffer, 0, buffer.length, startOffset);
          fs.closeSync(fd);
        } else {
          fs.appendFileSync(pending.tempPath, buffer);
        }
      } else {
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

    // Delete old archive if this key already existed (prevents orphaned files)
    const oldEntry = state.caches.get(pending.key);
    if (oldEntry) {
      const oldMatch = oldEntry.archiveLocation.match(/artifacts\/(\d+)/);
      if (oldMatch) {
        const oldPath = path.join(CACHE_DIR, `cache_${oldMatch[1]}.tar.gz`);
        try {
          fs.unlinkSync(oldPath);
          console.log(`[DTU] Deleted old cache file: ${oldPath}`);
        } catch {
          // File may already be gone
        }
      }
    }

    const finalPath = path.join(CACHE_DIR, `cache_${cacheId}.tar.gz`);
    fs.renameSync(pending.tempPath, finalPath);

    const baseUrl = getBaseUrl(req);
    const archiveLocation = `${baseUrl}/_apis/artifactcache/artifacts/${cacheId}`;

    state.caches.set(pending.key, {
      version: pending.version,
      archiveLocation,
      size,
    });
    state.saveCachesToDisk();
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
