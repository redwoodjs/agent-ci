import path from "node:path";
import fs from "node:fs";
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
