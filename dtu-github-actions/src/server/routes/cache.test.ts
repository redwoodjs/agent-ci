import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { state } from "../store.js";
import { bootstrapAndReturnApp } from "../index.js";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";

let PORT: number;

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

    // 2. Reserve
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "my-key", version: "1" }),
    });
    expect(res.status).toBe(201);
    const { cacheId } = await res.json();
    expect(cacheId).toBeDefined();

    // 3. Upload chunk
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches/${cacheId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/octet-stream", "Content-Range": "bytes 0-11/*" },
      body: "hello world!",
    });
    expect(res.status).toBe(200);

    // 4. Commit
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches/${cacheId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: 12 }),
    });
    expect(res.status).toBe(200);

    // 5. Check hit
    res = await fetch(`${baseUrl}/_apis/artifactcache/caches?keys=my-key&version=1`);
    expect(res.status).toBe(200);
    const hitData = await res.json();
    expect(hitData.result).toBe("hit");
    expect(hitData.archiveLocation).toBe(`${baseUrl}/_apis/artifactcache/artifacts/${cacheId}`);

    // 6. Download cache
    res = await fetch(hitData.archiveLocation);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("hello world!");
  });
});
