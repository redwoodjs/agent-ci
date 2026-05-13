import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __test_resetInFlight,
  defaultCacheRoot,
  ensureMachinenRootfs,
  OVERRIDE_PATH_FRAGMENT,
} from "./rootfs.ts";

// ─── Fake fetch ───────────────────────────────────────────────────────────────

interface FakeResponse {
  status?: number;
  statusText?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
}

function makeFetcher(scripted: FakeResponse | FakeResponse[] | (() => FakeResponse)): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let idx = 0;
  const fetcher = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const initHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(initHeaders)) {
      headers[k] = initHeaders[k];
    }
    calls.push({ url, headers });
    const resp =
      typeof scripted === "function"
        ? scripted()
        : Array.isArray(scripted)
          ? scripted[Math.min(idx++, scripted.length - 1)]
          : scripted;
    const status = resp.status ?? 200;
    const body =
      resp.body === undefined
        ? null
        : Readable.from([typeof resp.body === "string" ? Buffer.from(resp.body) : resp.body]);
    return {
      status,
      statusText: resp.statusText ?? "OK",
      ok: status >= 200 && status < 300,
      body: body as unknown as ReadableStream<Uint8Array> | null,
      headers: {
        get: (name: string) => resp.headers?.[name.toLowerCase()] ?? null,
      } as Response["headers"],
    } as unknown as Response;
  }) as typeof fetch;
  return { fetcher, calls };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("defaultCacheRoot", () => {
  it("lives under ~/.cache/agent-ci/machinen", () => {
    expect(defaultCacheRoot()).toBe(path.join(os.homedir(), ".cache", "agent-ci", "machinen"));
  });
});

describe("ensureMachinenRootfs — override path", () => {
  let repoRoot: string;
  let cacheRoot: string;
  beforeEach(async () => {
    __test_resetInFlight();
    repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rootfs-override-"));
    cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rootfs-cache-"));
  });
  afterEach(async () => {
    await fsp.rm(repoRoot, { recursive: true, force: true });
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  });

  it("returns the override path verbatim when the file exists", async () => {
    const override = path.join(repoRoot, OVERRIDE_PATH_FRAGMENT);
    await fsp.mkdir(path.dirname(override), { recursive: true });
    await fsp.writeFile(override, "user rootfs");
    const { fetcher, calls } = makeFetcher({ body: "should-not-fetch" });
    const result = await ensureMachinenRootfs({ repoRoot, cacheRoot, fetcher });
    expect(result.source).toBe("override");
    expect(result.path).toBe(override);
    expect(calls.length).toBe(0);
  });
});

describe("ensureMachinenRootfs — download path", () => {
  let repoRoot: string;
  let cacheRoot: string;
  const url = "https://example.test/rootfs.tar.gz";

  beforeEach(async () => {
    __test_resetInFlight();
    repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rootfs-repo-"));
    cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rootfs-cache-"));
  });
  afterEach(async () => {
    await fsp.rm(repoRoot, { recursive: true, force: true });
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  });

  it("downloads on cold cache, returns 'downloaded'", async () => {
    const { fetcher, calls } = makeFetcher({
      body: "fresh-rootfs",
      headers: { etag: `"v1"` },
    });
    const result = await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher });
    expect(result.source).toBe("downloaded");
    expect(fs.existsSync(result.path)).toBe(true);
    expect(await fsp.readFile(result.path, "utf8")).toBe("fresh-rootfs");
    expect(calls.length).toBe(1);
    expect(calls[0].headers["If-None-Match"]).toBeUndefined();
  });

  it("sends If-None-Match on warm cache and returns 'cached' on 304", async () => {
    // First call to seed the cache.
    const first = makeFetcher({ body: "v1-body", headers: { etag: `"v1"` } });
    await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: first.fetcher });
    __test_resetInFlight();

    const second = makeFetcher({ status: 304, statusText: "Not Modified" });
    const result = await ensureMachinenRootfs({
      repoRoot,
      cacheRoot,
      url,
      fetcher: second.fetcher,
    });
    expect(result.source).toBe("cached");
    expect(await fsp.readFile(result.path, "utf8")).toBe("v1-body");
    expect(second.calls[0].headers["If-None-Match"]).toBe(`"v1"`);
  });

  it("re-downloads when the body changes and returns 'refreshed'", async () => {
    const first = makeFetcher({ body: "v1-body", headers: { etag: `"v1"` } });
    await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: first.fetcher });
    __test_resetInFlight();

    const second = makeFetcher({ body: "v2-body", headers: { etag: `"v2"` } });
    const result = await ensureMachinenRootfs({
      repoRoot,
      cacheRoot,
      url,
      fetcher: second.fetcher,
    });
    expect(result.source).toBe("refreshed");
    expect(await fsp.readFile(result.path, "utf8")).toBe("v2-body");
  });

  it("falls back to cache when the network fails", async () => {
    const first = makeFetcher({ body: "v1", headers: { etag: `"v1"` } });
    await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: first.fetcher });
    __test_resetInFlight();

    const offline = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const result = await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: offline });
    expect(result.source).toBe("cached");
  });

  it("errors when the network fails and no cache exists", async () => {
    const offline = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    await expect(
      ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: offline }),
    ).rejects.toThrow(/ENETUNREACH/);
  });

  it("falls back to cache on a non-OK response when cache exists", async () => {
    const first = makeFetcher({ body: "v1", headers: { etag: `"v1"` } });
    await ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher: first.fetcher });
    __test_resetInFlight();

    const second = makeFetcher({ status: 500, statusText: "Server Error" });
    const result = await ensureMachinenRootfs({
      repoRoot,
      cacheRoot,
      url,
      fetcher: second.fetcher,
    });
    expect(result.source).toBe("cached");
  });

  it("dedups concurrent first-use calls into one fetch", async () => {
    let inflight = 0;
    let releases: Array<() => void> = [];
    const fetcher: typeof fetch = (async () => {
      inflight += 1;
      await new Promise<void>((r) => releases.push(r));
      return {
        status: 200,
        statusText: "OK",
        ok: true,
        body: Readable.from([Buffer.from("v1")]) as unknown as ReadableStream<Uint8Array>,
        headers: {
          get: (n: string) => (n.toLowerCase() === "etag" ? `"v1"` : null),
        } as Response["headers"],
      } as unknown as Response;
    }) as typeof fetch;

    const a = ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher });
    const b = ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher });
    const c = ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher });

    // Wait until the fetcher is actually called once, then release.
    await new Promise((r) => setTimeout(r, 10));
    releases.forEach((fn) => fn());

    const results = await Promise.all([a, b, c]);
    expect(new Set(results.map((r) => r.path)).size).toBe(1);
    expect(inflight).toBe(1);
  });

  it("cleans up the .partial file when the stream fails mid-flight", async () => {
    const cachePath = path.join(cacheRoot, "base.tar.gz");
    const explodingStream = new Readable({
      read() {
        this.destroy(new Error("stream collapsed"));
      },
    });
    const fetcher: typeof fetch = (async () =>
      ({
        status: 200,
        statusText: "OK",
        ok: true,
        body: explodingStream as unknown as ReadableStream<Uint8Array>,
        headers: { get: () => null } as Response["headers"],
      }) as unknown as Response) as typeof fetch;

    await expect(ensureMachinenRootfs({ repoRoot, cacheRoot, url, fetcher })).rejects.toThrow(
      /stream collapsed/,
    );
    expect(fs.existsSync(`${cachePath}.partial`)).toBe(false);
  });

  it("invalidates the cache when the URL changes (mirror swap)", async () => {
    const url1 = "https://mirror-a.test/rootfs.tar.gz";
    const url2 = "https://mirror-b.test/rootfs.tar.gz";
    const first = makeFetcher({ body: "from-a", headers: { etag: `"a1"` } });
    await ensureMachinenRootfs({ repoRoot, cacheRoot, url: url1, fetcher: first.fetcher });
    __test_resetInFlight();

    const second = makeFetcher({ body: "from-b", headers: { etag: `"b1"` } });
    const result = await ensureMachinenRootfs({
      repoRoot,
      cacheRoot,
      url: url2,
      fetcher: second.fetcher,
    });
    // Old etag must NOT have been sent — we re-fetch on URL change.
    expect(second.calls[0].headers["If-None-Match"]).toBeUndefined();
    expect(await fsp.readFile(result.path, "utf8")).toBe("from-b");
  });
});
