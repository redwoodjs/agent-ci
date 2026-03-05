import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

/**
 * Copy workspace files from a git repo root to dest using git ls-files.
 * On macOS: uses per-file `cp -c` (APFS CoW clones) for zero-disk copies.
 * On Linux: uses rsync with file list from git ls-files.
 * Fallback: Node.js fs.cpSync when neither is available.
 *
 * Only copies tracked + untracked-but-not-gitignored files (respects .gitignore).
 */
export function copyWorkspace(repoRoot: string, dest: string): void {
  try {
    if (process.platform === "darwin") {
      // On macOS with APFS, use per-file cp -c (CoW clone).
      // Each file shares physical blocks until actually modified.
      execSync(
        `git ls-files --cached --others --exclude-standard -z | xargs -0 -I{} sh -c 'mkdir -p "$(dirname "${dest}/{}")" && cp -c "{}" "${dest}/{}" 2>/dev/null || cp "{}" "${dest}/{}"'`,
        { stdio: "pipe", shell: "/bin/sh", cwd: repoRoot },
      );
    } else {
      // Linux/other: use rsync (fast, honours gitignore via git ls-files)
      execSync(
        `git ls-files --cached --others --exclude-standard -z | rsync -a --files-from=- --from0 ./ ${dest}/`,
        { stdio: "pipe", shell: "/bin/sh", cwd: repoRoot },
      );
    }
  } catch {
    // Fallback: use Node.js fs.cpSync when rsync/cp is not available
    const files = execSync(`git ls-files --cached --others --exclude-standard -z`, {
      stdio: "pipe",
      cwd: repoRoot,
    })
      .toString()
      .split("\0")
      .filter(Boolean);
    for (const file of files) {
      const src = path.join(repoRoot, file);
      const fileDest = path.join(dest, file);
      try {
        fs.mkdirSync(path.dirname(fileDest), { recursive: true });
        fs.cpSync(src, fileDest, { force: true, recursive: true });
      } catch {
        // Skip files that can't be copied (e.g. symlinks broken, etc.)
      }
    }
  }
}

/**
 * Remove stale `oa-runner-*` workspace directories older than `maxAgeMs`.
 * Returns an array of directory names that were pruned.
 */
export function pruneStaleWorkspaces(workDir: string, maxAgeMs: number): string[] {
  const workPath = path.join(workDir, "work");
  if (!fs.existsSync(workPath)) {
    return [];
  }

  const now = Date.now();
  const pruned: string[] = [];

  for (const entry of fs.readdirSync(workPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("oa-runner-")) {
      continue;
    }

    const dirPath = path.join(workPath, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        pruned.push(entry.name);
      }
    } catch {
      // Skip dirs we can't stat
    }
  }

  return pruned;
}

/**
 * Calculate the total size of a directory tree in bytes.
 */
function dirSizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) {
    return 0;
  }
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          total += fs.statSync(fullPath).size;
        } else if (entry.isDirectory()) {
          total += dirSizeBytes(fullPath);
        }
      } catch {
        // Skip entries we can't stat (permissions, broken symlinks)
      }
    }
  } catch {
    // Can't read dir
  }
  return total;
}

export interface WorkspaceItem {
  name: string;
  sizeBytes: number;
  ageMs: number;
}

export interface DiskUsage {
  workspaces: {
    totalBytes: number;
    count: number;
    items: WorkspaceItem[];
  };
  pnpmStoreBytes: number;
  playwrightCacheBytes: number;
  logsBytes: number;
  totalBytes: number;
}

/**
 * Get disk usage for all managed directories under `workDir`.
 */
export function getDiskUsage(workDir: string): DiskUsage {
  const now = Date.now();
  const workPath = path.join(workDir, "work");
  const items: WorkspaceItem[] = [];

  if (fs.existsSync(workPath)) {
    for (const entry of fs.readdirSync(workPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("oa-runner-")) {
        continue;
      }
      const dirPath = path.join(workPath, entry.name);
      try {
        const stat = fs.statSync(dirPath);
        items.push({
          name: entry.name,
          sizeBytes: dirSizeBytes(dirPath),
          ageMs: now - stat.mtimeMs,
        });
      } catch {
        // Skip
      }
    }
  }

  const workspaceTotalBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);

  // Scan all pnpm-store subdirs
  const pnpmStoreBytes = dirSizeBytes(path.join(workDir, "pnpm-store"));
  const playwrightCacheBytes = dirSizeBytes(path.join(workDir, "playwright-cache"));
  const logsBytes = dirSizeBytes(path.join(workDir, "logs"));

  return {
    workspaces: {
      totalBytes: workspaceTotalBytes,
      count: items.length,
      items: items.sort((a, b) => b.ageMs - a.ageMs),
    },
    pnpmStoreBytes,
    playwrightCacheBytes,
    logsBytes,
    totalBytes: workspaceTotalBytes + pnpmStoreBytes + playwrightCacheBytes + logsBytes,
  };
}
