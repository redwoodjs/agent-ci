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
  const maxBuffer = 100 * 1024 * 1024; // 100MB — default 1MB overflows in large monorepos

  // Identify git-tracked symlinks (mode 120000) upfront via a single git call
  // so we can handle them without per-file lstat syscalls.
  const symlinks = new Set<string>();
  const staged = execSync("git ls-files -s -z", {
    stdio: "pipe",
    cwd: repoRoot,
    maxBuffer,
  })
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const entry of staged) {
    // Format: "<mode> <hash> <stage>\t<path>"
    if (entry.startsWith("120000 ")) {
      const tabIdx = entry.indexOf("\t");
      if (tabIdx !== -1) {
        symlinks.add(entry.slice(tabIdx + 1));
      }
    }
  }

  // Get the full list of files to copy (NUL-separated for safety with
  // paths that contain spaces or special characters).
  const files = execSync("git ls-files --cached --others --exclude-standard -z", {
    stdio: "pipe",
    cwd: repoRoot,
    maxBuffer,
  })
    .toString()
    .split("\0")
    .filter(Boolean);

  // Recreate symlinks in dest (cheap: no disk I/O beyond the link inode).
  for (const file of symlinks) {
    const src = path.join(repoRoot, file);
    const fileDest = path.join(dest, file);
    try {
      fs.mkdirSync(path.dirname(fileDest), { recursive: true });
      fs.symlinkSync(fs.readlinkSync(src), fileDest);
    } catch {
      // Skip broken symlinks
    }
  }

  // Copy regular files (excluding symlinks already handled above).
  const regularFiles = symlinks.size > 0 ? files.filter((f) => !symlinks.has(f)) : files;

  if (process.platform === "darwin") {
    // On macOS with APFS, use per-file cp -c (CoW clone) via execFileSync so
    // file names are never interpreted by a shell.
    for (const file of regularFiles) {
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
    const input = regularFiles.join("\0");
    const result = spawnSync("rsync", ["-a", "--files-from=-", "--from0", "./", dest + "/"], {
      input,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: repoRoot,
    });
    if (result.status !== 0) {
      // rsync not available — fall through to Node.js fallback
      copyViaNodeFs(repoRoot, dest, regularFiles);
    }
  }
}

/** Node.js fallback: copy each file individually using fs.cpSync.
 *  Callers must pre-filter symlinks — this only handles regular files. */
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
 * All supported lockfile names, in priority order.
 * The first one found is used as the cache key source.
 */
const LOCKFILE_NAMES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
];

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

const LOCKFILE_TO_PM: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};

/**
 * Detect the project's package manager by looking for lockfiles in the repo root.
 * Returns the first match in priority order, or null if no lockfile is found.
 */
export function detectPackageManager(repoRoot: string): PackageManager | null {
  for (const name of LOCKFILE_NAMES) {
    if (fs.existsSync(path.join(repoRoot, name))) {
      return LOCKFILE_TO_PM[name]!;
    }
  }
  return null;
}

/**
 * Compute a short SHA-256 hash of lockfiles tracked in the repo.
 * Searches for all known lockfile types (pnpm, npm, yarn, bun) and hashes
 * whichever are found. Used as a cache key for immutable dependency snapshots
 * so completed snapshots are automatically invalidated when dependencies change.
 *
 * Returns "no-lockfile" if no lockfile is found.
 */
export function computeLockfileHash(repoRoot: string): string {
  // Build a git ls-files query that matches all known lockfile names
  const patterns = LOCKFILE_NAMES.flatMap((name) => [`'**/${name}'`, `'${name}'`]);
  let lockfiles: string[];
  try {
    lockfiles = execSync(`git ls-files --cached -- ${patterns.join(" ")}`, {
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
    for (const name of LOCKFILE_NAMES) {
      const rootLockfile = path.join(repoRoot, name);
      if (fs.existsSync(rootLockfile)) {
        lockfiles = [name];
        break;
      }
    }
    if (lockfiles.length === 0) {
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
