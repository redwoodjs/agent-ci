import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { PackageManager } from "../output/cleanup.ts";

export const NODE_MODULES_CACHE_SCHEMA = 1;
const COMPLETE_FILE = "complete.json";
const TREE_DIR = "node_modules";
const PUBLISH_LOCK_SUFFIX = ".publish-lock";
const STAGING_MARKER = ".staging-";
const LOCK_STALE_MS = 10 * 60 * 1000;

export type DependencyCacheMode = "snapshot" | "download-only";
export type CloneStrategy = "apfs-clone" | "reflink" | "copy";

export interface DependencyCacheManifest {
  schemaVersion: number;
  packageManager: PackageManager;
  lockfileHash: string;
  mode: DependencyCacheMode;
  createdAt: string;
}

export interface DependencyCacheIdentity {
  packageManager: PackageManager;
  lockfileHash: string;
}

export interface RestoredDependencyCache {
  restored: boolean;
  mode?: DependencyCacheMode;
  strategy?: CloneStrategy;
  durationMs: number;
}

export interface PublishedDependencyCache {
  published: boolean;
  mode?: DependencyCacheMode;
  strategy?: CloneStrategy;
  durationMs: number;
  reason?: "already-complete" | "missing-node-modules";
}

export function dependencyCacheMode(packageManager: PackageManager): DependencyCacheMode {
  // npm ci always removes node_modules before installing. Reusing npm's supported
  // download cache is useful; copying a node_modules tree only adds work.
  return packageManager === "npm" ? "download-only" : "snapshot";
}

export function resolveDependencyCacheDir(
  workingDir: string,
  repoSlug: string,
  identity: DependencyCacheIdentity,
): string {
  return path.resolve(
    workingDir,
    "cache",
    "node-modules-v2",
    repoSlug,
    identity.packageManager,
    identity.lockfileHash,
  );
}

export function readDependencyCacheManifest(cacheDir: string): DependencyCacheManifest | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(cacheDir, COMPLETE_FILE), "utf8"),
    ) as DependencyCacheManifest;
    if (
      parsed.schemaVersion !== NODE_MODULES_CACHE_SCHEMA ||
      !parsed.packageManager ||
      !parsed.lockfileHash ||
      (parsed.mode !== "snapshot" && parsed.mode !== "download-only")
    ) {
      return undefined;
    }
    if (parsed.mode === "snapshot" && !fs.statSync(path.join(cacheDir, TREE_DIR)).isDirectory()) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function isDependencyCacheComplete(cacheDir: string): boolean {
  return readDependencyCacheManifest(cacheDir) !== undefined;
}

export function cloneDependencyTree(
  sourceDir: string,
  destinationDir: string,
  platform = process.platform,
): CloneStrategy {
  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o777 });

  if (platform === "darwin") {
    const cloned = spawnSync("cp", ["-c", "-R", "-p", `${sourceDir}/.`, destinationDir], {
      stdio: "pipe",
    });
    if (cloned.status === 0) {
      return "apfs-clone";
    }
    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o777 });
  } else if (platform === "linux") {
    const reflinked = spawnSync(
      "cp",
      ["-a", "--reflink=always", `${sourceDir}/.`, destinationDir],
      { stdio: "pipe" },
    );
    if (reflinked.status === 0) {
      return "reflink";
    }
    fs.rmSync(destinationDir, { recursive: true, force: true });
    fs.mkdirSync(destinationDir, { recursive: true, mode: 0o777 });
  }

  const copied = spawnSync("cp", ["-R", "-p", `${sourceDir}/.`, destinationDir], {
    stdio: "pipe",
  });
  if (copied.status === 0) {
    return "copy";
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, destinationDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  return "copy";
}

export function restoreDependencyCache(
  cacheDir: string,
  destinationNodeModules: string,
): RestoredDependencyCache {
  const startedAt = Date.now();
  const manifest = readDependencyCacheManifest(cacheDir);
  if (!manifest) {
    return { restored: false, durationMs: Date.now() - startedAt };
  }
  if (manifest.mode === "download-only") {
    return {
      restored: false,
      mode: manifest.mode,
      durationMs: Date.now() - startedAt,
    };
  }

  const strategy = cloneDependencyTree(path.join(cacheDir, TREE_DIR), destinationNodeModules);
  return {
    restored: true,
    mode: manifest.mode,
    strategy,
    durationMs: Date.now() - startedAt,
  };
}

function lockIsStale(lockDir: string): boolean {
  try {
    const createdAt = Number(fs.readFileSync(path.join(lockDir, "created-at"), "utf8"));
    return !Number.isFinite(createdAt) || Date.now() - createdAt > LOCK_STALE_MS;
  } catch {
    // Another publisher can observe the directory between atomic mkdir and the
    // created-at write. Fall back to the directory mtime instead of stealing a
    // brand-new lock.
    try {
      return Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

async function acquirePublishLock(cacheDir: string): Promise<string> {
  const lockDir = `${cacheDir}${PUBLISH_LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(cacheDir), { recursive: true, mode: 0o777 });
  const deadline = Date.now() + 30_000;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o777 });
      fs.writeFileSync(path.join(lockDir, "created-at"), String(Date.now()));
      return lockDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (isDependencyCacheComplete(cacheDir)) {
        return "";
      }
      if (lockIsStale(lockDir)) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to publish dependency cache: ${cacheDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function publishDependencyCache(options: {
  cacheDir: string;
  sourceNodeModules: string;
  identity: DependencyCacheIdentity;
}): Promise<PublishedDependencyCache> {
  const startedAt = Date.now();
  if (isDependencyCacheComplete(options.cacheDir)) {
    return {
      published: false,
      durationMs: Date.now() - startedAt,
      reason: "already-complete",
    };
  }

  const mode = dependencyCacheMode(options.identity.packageManager);
  if (!fs.existsSync(options.sourceNodeModules)) {
    return {
      published: false,
      mode,
      durationMs: Date.now() - startedAt,
      reason: "missing-node-modules",
    };
  }

  const lockDir = await acquirePublishLock(options.cacheDir);
  if (!lockDir) {
    return {
      published: false,
      mode,
      durationMs: Date.now() - startedAt,
      reason: "already-complete",
    };
  }

  const stagingDir = `${options.cacheDir}${STAGING_MARKER}${process.pid}-${Date.now()}`;
  let strategy: CloneStrategy | undefined;
  try {
    if (isDependencyCacheComplete(options.cacheDir)) {
      return {
        published: false,
        mode,
        durationMs: Date.now() - startedAt,
        reason: "already-complete",
      };
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true, mode: 0o777 });
    if (mode === "snapshot") {
      strategy = cloneDependencyTree(options.sourceNodeModules, path.join(stagingDir, TREE_DIR));
    }

    const manifest: DependencyCacheManifest = {
      schemaVersion: NODE_MODULES_CACHE_SCHEMA,
      packageManager: options.identity.packageManager,
      lockfileHash: options.identity.lockfileHash,
      mode,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(stagingDir, COMPLETE_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    if (fs.existsSync(options.cacheDir)) {
      fs.rmSync(options.cacheDir, { recursive: true, force: true });
    }
    fs.renameSync(stagingDir, options.cacheDir);

    return {
      published: true,
      mode,
      strategy,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

export function pruneAbandonedDependencyCacheEntries(rootDir: string, maxAgeMs: number): void {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const now = Date.now();
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.includes(STAGING_MARKER) && !entry.name.endsWith(PUBLISH_LOCK_SUFFIX)) {
      continue;
    }
    const fullPath = path.join(rootDir, entry.name);
    try {
      if (now - fs.statSync(fullPath).mtimeMs > maxAgeMs) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cache maintenance.
    }
  }
}
