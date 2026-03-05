import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync, execSync, spawnSync } from "node:child_process";

/**
 * Copy workspace files from a git repo root to dest using git ls-files.
 * On macOS: uses per-file `cp -c` (APFS CoW clones) for zero-disk copies.
 * On Linux: uses rsync with file list from git ls-files.
 * Fallback: Node.js fs.cpSync when neither is available.
 *
 * Only copies tracked + untracked-but-not-gitignored files (respects .gitignore).
 * File paths are never interpolated into shell strings — arguments are always
 * passed as arrays to avoid shell injection.
 */
export function copyWorkspace(repoRoot: string, dest: string): void {
  // Get the list of files to copy from git (NUL-separated for safety with
  // paths that contain spaces or special characters).
  const files = execSync("git ls-files --cached --others --exclude-standard -z", {
    stdio: "pipe",
    cwd: repoRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean);

  if (process.platform === "darwin") {
    // On macOS with APFS, use per-file cp -c (CoW clone) via execFileSync so
    // file names are never interpreted by a shell.
    for (const file of files) {
      const src = path.join(repoRoot, file);
      const fileDest = path.join(dest, file);
      try {
        fs.mkdirSync(path.dirname(fileDest), { recursive: true });
        // Try CoW clone first; fall back to regular copy.
        const result = spawnSync("cp", ["-c", src, fileDest], { stdio: "pipe" });
        if (result.status !== 0) {
          execFileSync("cp", [src, fileDest], { stdio: "pipe" });
        }
      } catch {
        // Skip files that can't be copied (e.g. broken symlinks)
      }
    }
  } else {
    // Linux/other: pass the file list to rsync via stdin (--files-from=-)
    // with --from0 so NUL-delimited names are handled correctly.
    // dest is passed as a positional argument, never shell-interpolated.
    const input = files.join("\0");
    const result = spawnSync("rsync", ["-a", "--files-from=-", "--from0", "./", dest + "/"], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
    });
    if (result.status !== 0) {
      // rsync not available — fall through to Node.js fallback
      copyViaNodeFs(repoRoot, dest, files);
    }
  }
}

/** Node.js fallback: copy each file individually using fs.cpSync. */
function copyViaNodeFs(repoRoot: string, dest: string, files: string[]): void {
  for (const file of files) {
    const src = path.join(repoRoot, file);
    const fileDest = path.join(dest, file);
    try {
      fs.mkdirSync(path.dirname(fileDest), { recursive: true });
      fs.cpSync(src, fileDest, { force: true, recursive: true });
    } catch {
      // Skip files that can't be copied (e.g. broken symlinks)
    }
  }
}

/**
 * Compute a short SHA-256 hash of all pnpm-lock.yaml files tracked in the repo.
 * Used as a cache key for the warm node_modules directory so the snapshot is
 * automatically invalidated when dependencies change.
 *
 * Returns "no-lockfile" if no pnpm-lock.yaml is found.
 */
export function computeLockfileHash(repoRoot: string): string {
  let lockfiles: string[];
  try {
    lockfiles = execSync("git ls-files --cached -- '**/pnpm-lock.yaml' 'pnpm-lock.yaml'", {
      stdio: "pipe",
      cwd: repoRoot,
    })
      .toString()
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    lockfiles = [];
  }

  if (lockfiles.length === 0) {
    // Also try a direct filesystem check for untracked lockfiles
    const rootLockfile = path.join(repoRoot, "pnpm-lock.yaml");
    if (fs.existsSync(rootLockfile)) {
      lockfiles = ["pnpm-lock.yaml"];
    } else {
      return "no-lockfile";
    }
  }

  const hash = crypto.createHash("sha256");
  for (const file of lockfiles.sort()) {
    try {
      hash.update(fs.readFileSync(path.join(repoRoot, file)));
    } catch {
      // Skip unreadable files
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Check whether a warm node_modules directory is populated (non-empty).
 * Used by the wave scheduler to decide whether to serialize the first job.
 */
export function isWarmNodeModules(warmDir: string): boolean {
  try {
    return fs.existsSync(warmDir) && fs.readdirSync(warmDir).length > 0;
  } catch {
    return false;
  }
}
