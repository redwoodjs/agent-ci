import fs from "node:fs";
import path from "node:path";

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
