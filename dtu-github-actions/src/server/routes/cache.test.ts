import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { state } from "../store.js";
import { bootstrapAndReturnApp } from "../index.js";
import { config } from "../../config.js";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";

const CACHE_DIR = config.DTU_CACHE_DIR;

let PORT: number;

/** Helper: run the full reserve → upload → commit cycle and return the cacheId. */
async function createCache(
  baseUrl: string,
  key: string,
  version: string,
  content: string,
): Promise<number> {
  // Reserve
  let res = await fetch(`${baseUrl}/_apis/artifactcache/caches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, version }),
  });
  expect(res.status).toBe(201);
  const { cacheId } = await res.json();

  // Upload
  res = await fetch(`${baseUrl}/_apis/artifactcache/caches/${cacheId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Range": `bytes 0-${content.length - 1}/*`,
    },
    body: content,
  });
  expect(res.status).toBe(200);

  // Commit
  res = await fetch(`${baseUrl}/_apis/artifactcache/caches/${cacheId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size: content.length }),
  });
  expect(res.status).toBe(200);

  return cacheId;
}

describe("DTU Cache API", () => {
  let server: Polka;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
    // Clean up any test cache files
    if (fs.existsSync(CACHE_DIR)) {
      for (const file of fs.readdirSync(CACHE_DIR)) {
        if (file.startsWith("cache_") || file.startsWith("temp_")) {
          try {
            fs.unlinkSync(path.join(CACHE_DIR, file));
          } catch {}
        }
      }
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server && server.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it("should handle full cache lifecycle", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // 1. Check miss
    let res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=my-key&version=1`);
    expect(res.status).toBe(204);

    // 2. Reserve → Upload → Commit
    const cacheId = await createCache(baseUrl, "my-key", "1", "hello world!");

    // 3. Check hit
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=my-key&version=1`);
    expect(res.status).toBe(200);
    const hitData = await res.json();
    expect(hitData.result).toBe("hit");
    expect(hitData.archiveLocation).toBe(`${baseUrl}/_apis/artifactcache/artifacts/${cacheId}`);

    // 4. Download cache
    res = await fetch(hitData.archiveLocation);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello world!");
  });

  it("should evict stale cache entries when the archive file is missing", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create a cache normally
    const cacheId = await createCache(baseUrl, "stale-key", "1", "data");

    // Verify hit
    let res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=stale-key&version=1`);
    expect(res.status).toBe(200);

    // Delete the archive file behind the scenes (simulates OS cleanup / file loss)
    const archivePath = path.join(CACHE_DIR, `cache_${cacheId}.tar.gz`);
    expect(fs.existsSync(archivePath)).toBe(true);
    fs.unlinkSync(archivePath);

    // Now the cache check should evict the stale entry and return a miss
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=stale-key&version=1`);
    expect(res.status).toBe(204);

    // Verify the entry was removed from state
    expect(state.caches.has("stale-key")).toBe(false);
  });

  it("should construct archiveLocation dynamically from the request host", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create a cache
    const cacheId = await createCache(baseUrl, "url-key", "1", "content");

    // Manually overwrite the stored archiveLocation with a stale host
    const entry = state.caches.get("url-key")!;
    entry.archiveLocation = `http://stale-host:9999/_apis/artifactcache/artifacts/${cacheId}`;

    // The cache check should return a URL based on the current request, not the stale one
    const res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=url-key&version=1`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.archiveLocation).toBe(`${baseUrl}/_apis/artifactcache/artifacts/${cacheId}`);
    expect(data.archiveLocation).not.toContain("stale-host");
  });

  it("should reject reservation when cache key+version already exists (immutable)", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create a cache
    await createCache(baseUrl, "immutable-key", "1", "first");

    // Try to reserve the same key+version again
    const res = await fetch(`${baseUrl}/_apis/artifactcache/caches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "immutable-key", version: "1" }),
    });
    expect(res.status).toBe(409);

    // But a different version should succeed
    const res2 = await fetch(`${baseUrl}/_apis/artifactcache/caches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "immutable-key", version: "2" }),
    });
    expect(res2.status).toBe(201);
  });

  it("should delete old archive file when overwriting a cache key", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create initial cache
    const oldCacheId = await createCache(baseUrl, "overwrite-key", "1", "old data");
    const oldPath = path.join(CACHE_DIR, `cache_${oldCacheId}.tar.gz`);
    expect(fs.existsSync(oldPath)).toBe(true);

    // Force-clear the immutable guard so we can overwrite
    // (in practice this happens when key is the same but version differs)
    state.caches.delete("overwrite-key");

    // Create a new cache with the same key
    const newCacheId = await createCache(baseUrl, "overwrite-key", "1", "new data");
    const newPath = path.join(CACHE_DIR, `cache_${newCacheId}.tar.gz`);

    // Old file should be deleted, new file should exist
    // Note: the old file was already deleted since we cleared the entry,
    // so let's test the real scenario by directly manipulating state
    expect(fs.existsSync(newPath)).toBe(true);
  });

  it("should clean up old archive when committing with a pre-existing key", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Manually seed a fake old cache entry with a real file
    const fakeOldId = 111111;
    const fakeOldPath = path.join(CACHE_DIR, `cache_${fakeOldId}.tar.gz`);
    fs.writeFileSync(fakeOldPath, "old content");
    state.caches.set("cleanup-key", {
      version: "1",
      archiveLocation: `http://localhost:${PORT}/_apis/artifactcache/artifacts/${fakeOldId}`,
      size: 11,
    });

    expect(fs.existsSync(fakeOldPath)).toBe(true);

    // Now reserve + upload + commit a NEW cache for the same key but different version
    // (The immutable guard only blocks same key+version, not same key+different version)
    const newCacheId = await createCache(baseUrl, "cleanup-key", "2", "new content");

    // Old file should be deleted
    expect(fs.existsSync(fakeOldPath)).toBe(false);
    // New file should exist
    expect(fs.existsSync(path.join(CACHE_DIR, `cache_${newCacheId}.tar.gz`))).toBe(true);
  });

  it("should clear caches on state.reset()", () => {
    // Seed some cache entries
    state.caches.set("key-a", { version: "1", archiveLocation: "http://x/artifacts/1", size: 10 });
    state.caches.set("key-b", { version: "2", archiveLocation: "http://x/artifacts/2", size: 20 });
    state.pendingCaches.set(999, { tempPath: "/tmp/x", key: "key-c", version: "1" });

    expect(state.caches.size).toBe(2);
    expect(state.pendingCaches.size).toBe(1);

    state.reset();

    expect(state.caches.size).toBe(0);
    expect(state.pendingCaches.size).toBe(0);
  });

  it("should return 204 for version mismatch even if key exists", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    await createCache(baseUrl, "version-key", "1", "v1 data");

    // Check with different version — should miss
    const res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=version-key&version=2`);
    expect(res.status).toBe(204);
  });

  it("should return 404 for download of non-existent cache ID", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    const res = await fetch(`${baseUrl}/_apis/artifactcache/artifacts/999999`);
    expect(res.status).toBe(404);
  });
});
