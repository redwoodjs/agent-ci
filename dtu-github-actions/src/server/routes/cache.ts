import { Polka } from "polka";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { state } from "../store.js";
import { getBaseUrl } from "./dtu.js";
import { config } from "../../config.js";

// Ensure DTU has a temp dir for caching
const CACHE_DIR = config.DTU_CACHE_DIR;
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Pre-built empty tar.gz to serve as a synthetic cache hit for virtual keys.
// The runner downloads it, extracts nothing, and marks the key as a primary hit
// (so it skips the save step entirely). This avoids 60+ seconds of unnecessary
// gzip compression for bind-mounted paths like the pnpm store.
const EMPTY_TAR_GZ_PATH = path.join(CACHE_DIR, "__empty__.tar.gz");
if (!fs.existsSync(EMPTY_TAR_GZ_PATH)) {
  execSync(`tar -czf ${EMPTY_TAR_GZ_PATH} -T /dev/null`);
}
const VIRTUAL_CACHE_ID = 0; // sentinel ID for virtual (no-op) caches

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

      // Virtual key: bind-mounted path already on disk — return a synthetic hit
      // so the runner skips both the tar extraction and the tar save.
      if (state.isVirtualCacheKey(key)) {
        console.log(`[DTU] Virtual cache hit for key: ${key} (skip tar)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({
            result: "hit",
            archiveLocation: `${getBaseUrl(req)}/_apis/artifactcache/artifacts/${VIRTUAL_CACHE_ID}`,
            cacheKey: key,
          }),
        );
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
    res.writeHead(204);
    res.end();
  };

  app.get("/_apis/artifactcache/caches", checkCacheHandler);
  app.get("/_apis/artifactcache/cache", checkCacheHandler);

  // 2. Reserve cache space (create pending cache)
  app.post("/_apis/artifactcache/caches", (req: any, res) => {
    const { key, version } = req.body;

    console.log(`[DTU] Reserving cache for key: ${key} (version: ${version})`);

    // Virtual key: acknowledge immediately without touching disk
    if (state.isVirtualCacheKey(key)) {
      console.log(`[DTU] Virtual cache reservation for key: ${key} — no-op`);
      res.writeHead(201, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cacheId: VIRTUAL_CACHE_ID }));
    }

    // Immutable: reject if this key+version is already cached (committed)
    const existing = state.caches.get(key);
    if (existing && existing.version === version) {
      console.log(`[DTU] Cache already exists for key: ${key} — skipping reservation`);
      res.writeHead(409, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ message: "Cache already exists" }));
    }

    // Also reject if another job has already reserved this key+version (in-flight)
    // This prevents multiple parallel jobs from all winning a reservation for the
    // same cache key, generating redundant tar processes and orphaned temp files.
    for (const [, pending] of state.pendingCaches) {
      if (pending.key === key && pending.version === version) {
        console.log(
          `[DTU] Cache reservation in-flight for key: ${key} — another job is already saving it`,
        );
        res.writeHead(409, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ message: "Cache already exists" }));
      }
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

    // Virtual cache ID: discard the upload entirely — we don't need the archive
    if (cacheId === VIRTUAL_CACHE_ID) {
      res.writeHead(200);
      return res.end();
    }

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

    // Virtual cache ID: no-op commit
    if (cacheId === VIRTUAL_CACHE_ID) {
      res.writeHead(200);
      return res.end();
    }

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

    // Virtual sentinel: serve the empty tar.gz
    if (cacheId === VIRTUAL_CACHE_ID) {
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="cache.tar.gz"',
        "Content-Length": fs.statSync(EMPTY_TAR_GZ_PATH).size,
      });
      return fs.createReadStream(EMPTY_TAR_GZ_PATH).pipe(res);
    }

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
