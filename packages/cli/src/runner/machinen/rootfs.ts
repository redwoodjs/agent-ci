// Resolve the machinen rootfs for a job.
//
// Per ADR 0004:
//
//   1. If `<repoRoot>/.github/agent-ci.machinen.tar.gz` exists, that
//      file IS the rootfs. Use it verbatim — no download, no overlay.
//   2. Otherwise, download the latest pre-baked rootfs from agent-ci's
//      `machinen-rootfs-latest` GitHub release. Cache under
//      `~/.cache/agent-ci/machinen/`. On subsequent runs do a
//      conditional GET (If-None-Match) so we pick up re-bakes without
//      paying the full download cost every time. Fall back to the
//      cached copy if the network is unreachable.
//
// The previous design (provision-against-machinen-debian + parsed
// Dockerfile overlay) is gone — that pipeline now lives at release
// time in `scripts/machinen-bake.mjs` and produces the asset the
// runtime downloads here. See ADR 0004 for the full rationale.

import { homedir } from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { debugRunner } from "../../output/debug.ts";

export const DEFAULT_ROOTFS_URL =
  "https://github.com/redwoodjs/agent-ci/releases/download/machinen-rootfs-latest/agent-ci-machinen-runner-arm64.tar.gz";

export const OVERRIDE_PATH_FRAGMENT = path.join(".github", "agent-ci.machinen.tar.gz");

export type RootfsSource = "override" | "cached" | "downloaded" | "refreshed";

export interface MachinenRootfs {
  /** Absolute path to the rootfs tarball — feed straight into boot({ image }). */
  path: string;
  source: RootfsSource;
}

export interface ResolveOpts {
  repoRoot: string;
  /** Override the cache root (tests / non-default install layouts). */
  cacheRoot?: string;
  /** Override the published-asset URL (tests / mirrors). */
  url?: string;
  /** Test-injection — defaults to global fetch. */
  fetcher?: typeof fetch;
}

export function defaultCacheRoot(): string {
  return path.join(homedir(), ".cache", "agent-ci", "machinen");
}

// In-flight downloads, keyed by output path. Concurrent first-use
// callers share one promise so we never write two streams into the
// same .partial.
const inFlight = new Map<string, Promise<MachinenRootfs>>();

/**
 * Resolve the machinen rootfs for a repo. See module header for the
 * full contract.
 */
export async function ensureMachinenRootfs(opts: ResolveOpts): Promise<MachinenRootfs> {
  const override = path.join(opts.repoRoot, OVERRIDE_PATH_FRAGMENT);
  if (fs.existsSync(override)) {
    debugRunner(`[machinen] using override rootfs: ${override}`);
    return { path: override, source: "override" };
  }

  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const cachePath = path.join(cacheRoot, "base.tar.gz");
  const pending = inFlight.get(cachePath);
  if (pending) {
    return pending;
  }

  const promise = downloadOrRefresh({
    url: opts.url ?? DEFAULT_ROOTFS_URL,
    cachePath,
    fetcher: opts.fetcher ?? fetch,
  }).finally(() => inFlight.delete(cachePath));

  inFlight.set(cachePath, promise);
  return promise;
}

interface MetaJson {
  etag?: string;
  lastModified?: string;
  url?: string;
  /** When we last successfully refreshed (ms since epoch). Informational. */
  fetchedAt?: number;
}

async function downloadOrRefresh(args: {
  url: string;
  cachePath: string;
  fetcher: typeof fetch;
}): Promise<MachinenRootfs> {
  const { url, cachePath, fetcher } = args;
  const cacheRoot = path.dirname(cachePath);
  const metaPath = `${cachePath}.meta.json`;
  const partialPath = `${cachePath}.partial`;

  await fsp.mkdir(cacheRoot, { recursive: true });

  const meta = readMeta(metaPath);
  const cacheExists = fs.existsSync(cachePath);

  // If the cached file's URL doesn't match what the caller wants
  // (e.g. tests, mirrors), invalidate so we re-fetch from the new
  // origin instead of returning a stale body.
  const cacheUrlMatches = !cacheExists || meta?.url === url;

  const headers: Record<string, string> = {};
  if (cacheUrlMatches) {
    if (meta?.etag) {
      headers["If-None-Match"] = meta.etag;
    }
    if (meta?.lastModified) {
      headers["If-Modified-Since"] = meta.lastModified;
    }
  }

  let res: Response;
  try {
    res = await fetcher(url, { headers, redirect: "follow" });
  } catch (err) {
    if (cacheExists) {
      debugRunner(
        `[machinen] rootfs fetch failed (${err instanceof Error ? err.message : err}); falling back to cached copy at ${cachePath}`,
      );
      return { path: cachePath, source: "cached" };
    }
    throw new Error(
      `failed to download machinen rootfs from ${url} and no cache present: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (res.status === 304 && cacheExists) {
    debugRunner(`[machinen] rootfs unchanged (304) — using cache at ${cachePath}`);
    return { path: cachePath, source: "cached" };
  }

  if (!res.ok || !res.body) {
    if (cacheExists) {
      debugRunner(
        `[machinen] rootfs fetch returned ${res.status} ${res.statusText}; falling back to cached copy at ${cachePath}`,
      );
      return { path: cachePath, source: "cached" };
    }
    throw new Error(
      `failed to download machinen rootfs from ${url}: ${res.status} ${res.statusText}`,
    );
  }

  debugRunner(`[machinen] downloading rootfs from ${url}`);
  await fsp.rm(partialPath, { force: true });
  try {
    await pipeline(res.body as unknown as NodeJS.ReadableStream, fs.createWriteStream(partialPath));
  } catch (err) {
    await fsp.rm(partialPath, { force: true }).catch(() => {});
    if (cacheExists) {
      debugRunner(
        `[machinen] rootfs stream failed (${err instanceof Error ? err.message : err}); falling back to cached copy at ${cachePath}`,
      );
      return { path: cachePath, source: "cached" };
    }
    throw err;
  }

  await fsp.rename(partialPath, cachePath);
  writeMeta(metaPath, {
    url,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    fetchedAt: Date.now(),
  });

  return { path: cachePath, source: cacheExists ? "refreshed" : "downloaded" };
}

function readMeta(metaPath: string): MetaJson | null {
  if (!fs.existsSync(metaPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8")) as MetaJson;
  } catch {
    return null;
  }
}

function writeMeta(metaPath: string, meta: MetaJson): void {
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    // Cache-meta is informational. A read-only home dir or full disk
    // shouldn't fail the bake — log and continue.
    debugRunner(
      `[machinen] failed to write rootfs meta ${metaPath}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** Test-only: drop any in-flight download state. */
export function __test_resetInFlight(): void {
  inFlight.clear();
}
