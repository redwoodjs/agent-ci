import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "../output/working-directory.js";
import { computeLockfileHash, repairWarmCache } from "../output/cleanup.js";
import { config } from "../config.js";
import { findRepoRoot } from "./metadata.js";
import { debugRunner } from "../output/debug.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunDirectories {
  containerWorkDir: string;
  shimsDir: string;
  diagDir: string;
  toolCacheDir: string;
  pnpmStoreDir: string;
  playwrightCacheDir: string;
  warmModulesDir: string;
  workspaceDir: string;
  repoSlug: string;
}

export interface CreateRunDirectoriesOpts {
  runDir: string;
  githubRepo?: string;
  workflowPath?: string;
}

// ─── Directory creation ───────────────────────────────────────────────────────

/**
 * Create all per-run and shared-cache directories, returning the paths.
 *
 * Also verifies warm-cache integrity and ensures world-writable permissions
 * for DinD scenarios.
 */
export function createRunDirectories(opts: CreateRunDirectoriesOpts): RunDirectories {
  const { runDir, githubRepo, workflowPath } = opts;
  const workDir = getWorkingDirectory();

  // Per-run dirs
  const containerWorkDir = path.resolve(runDir, "work");
  const shimsDir = path.resolve(runDir, "shims");
  const diagDir = path.resolve(runDir, "diag");

  // Shared caches
  const repoSlug = (githubRepo || config.GITHUB_REPO).replace("/", "-");
  const toolCacheDir = path.resolve(workDir, "cache", "toolcache");
  const pnpmStoreDir = path.resolve(workDir, "cache", "pnpm-store", repoSlug);
  const playwrightCacheDir = path.resolve(workDir, "cache", "playwright", repoSlug);

  // Warm node_modules: keyed by the pnpm lockfile hash
  let lockfileHash = "no-lockfile";
  try {
    const repoRoot = workflowPath ? findRepoRoot(workflowPath) : undefined;
    if (repoRoot) {
      lockfileHash = computeLockfileHash(repoRoot);
    }
  } catch {
    // Best-effort; fall back to "no-lockfile"
  }
  const warmModulesDir = path.resolve(workDir, "cache", "warm-modules", repoSlug, lockfileHash);

  // Workspace path
  const repoName = (githubRepo || config.GITHUB_REPO).split("/").pop() || "repo";
  const workspaceDir = path.resolve(containerWorkDir, repoName, repoName);

  // Create all directories
  const allDirs = [
    workspaceDir,
    containerWorkDir,
    shimsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    playwrightCacheDir,
    warmModulesDir,
  ];
  for (const dir of allDirs) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o777 });
  }

  // Verify warm cache integrity
  const cacheStatus = repairWarmCache(warmModulesDir);
  if (cacheStatus === "repaired") {
    debugRunner(`Repaired corrupted warm cache: ${warmModulesDir}`);
  }

  // Ensure world-writable for DinD scenarios
  ensureWorldWritable(allDirs);

  return {
    containerWorkDir,
    shimsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    playwrightCacheDir,
    warmModulesDir,
    workspaceDir,
    repoSlug,
  };
}

// ─── Permissions helper ───────────────────────────────────────────────────────

/**
 * Ensure all directories are world-writable (0o777).
 * Errors are ignored (non-critical).
 */
export function ensureWorldWritable(dirs: string[]): void {
  try {
    for (const dir of dirs) {
      fs.chmodSync(dir, 0o777);
    }
  } catch {
    // Ignore chmod errors (non-critical)
  }
}
