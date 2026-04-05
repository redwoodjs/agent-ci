import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "../output/working-directory.js";
import { computeLockfileHash, detectPackageManager, repairWarmCache } from "../output/cleanup.js";
import type { PackageManager } from "../output/cleanup.js";
import { config } from "../config.js";
import { findRepoRoot } from "./metadata.js";
import { debugRunner } from "../output/debug.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RunDirectories {
  containerWorkDir: string;
  shimsDir: string;
  signalsDir: string;
  diagDir: string;
  toolCacheDir: string;
  pnpmStoreDir?: string;
  npmCacheDir?: string;
  bunCacheDir?: string;
  playwrightCacheDir: string;
  warmModulesDir: string;
  workspaceDir: string;
  repoSlug: string;
  detectedPM: PackageManager | null;
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
  const signalsDir = path.resolve(runDir, "signals");
  const diagDir = path.resolve(runDir, "diag");

  // Shared caches
  const repoSlug = (githubRepo || config.GITHUB_REPO).replace("/", "-");
  const toolCacheDir = path.resolve(workDir, "cache", "toolcache");
  const playwrightCacheDir = path.resolve(workDir, "cache", "playwright", repoSlug);

  // Detect the project's package manager so we only mount the relevant cache
  let detectedPM: PackageManager | null = null;
  const repoRoot = workflowPath ? findRepoRoot(workflowPath) : undefined;
  if (repoRoot) {
    detectedPM = detectPackageManager(repoRoot);
  }

  // Only create cache dirs for the detected PM (or all if unknown)
  const pnpmStoreDir =
    !detectedPM || detectedPM === "pnpm"
      ? path.resolve(workDir, "cache", "pnpm-store", repoSlug)
      : undefined;
  const npmCacheDir =
    !detectedPM || detectedPM === "npm"
      ? path.resolve(workDir, "cache", "npm-cache", repoSlug)
      : undefined;
  const bunCacheDir =
    !detectedPM || detectedPM === "bun"
      ? path.resolve(workDir, "cache", "bun-cache", repoSlug)
      : undefined;

  // Warm node_modules: keyed by the lockfile hash (any supported PM)
  let lockfileHash = "no-lockfile";
  try {
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
    signalsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    npmCacheDir,
    bunCacheDir,
    playwrightCacheDir,
    warmModulesDir,
  ].filter((d): d is string => d !== undefined);
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
    signalsDir,
    diagDir,
    toolCacheDir,
    pnpmStoreDir,
    npmCacheDir,
    bunCacheDir,
    playwrightCacheDir,
    warmModulesDir,
    workspaceDir,
    repoSlug,
    detectedPM,
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
