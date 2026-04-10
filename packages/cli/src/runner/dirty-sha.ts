import { execSync } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Compute a SHA that represents the current dirty working-tree state, as if
 * it were committed.  Uses a temporary index + `git write-tree` /
 * `git commit-tree` so no refs are moved and real history is untouched.
 *
 * Returns `undefined` when the tree is clean (no uncommitted changes).
 */
export function computeDirtySha(repoRoot: string): string | undefined {
  try {
    // Quick check: anything dirty?
    const status = execSync("git status --porcelain", {
      cwd: repoRoot,
      stdio: "pipe",
    })
      .toString()
      .trim();
    if (!status) {
      return undefined;
    }

    const gitDir = execSync("git rev-parse --git-dir", {
      cwd: repoRoot,
      stdio: "pipe",
    })
      .toString()
      .trim();
    const absoluteGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir);
    const tmpIndex = path.join(absoluteGitDir, `index-agent-ci-${Date.now()}`);

    try {
      // Seed the temp index from the real one so we start from the current staging area.
      fs.copyFileSync(path.join(absoluteGitDir, "index"), tmpIndex);

      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

      // Stage everything (tracked + untracked, respecting .gitignore) into the temp index.
      execSync("git add -A", { cwd: repoRoot, stdio: "pipe", env });

      // Write a tree object from the temp index.
      const tree = execSync("git write-tree", {
        cwd: repoRoot,
        stdio: "pipe",
        env,
      })
        .toString()
        .trim();

      // Create an ephemeral commit object parented on HEAD — no ref is updated.
      const sha = execSync(`git commit-tree ${tree} -p HEAD -m "agent-ci: dirty working tree"`, {
        cwd: repoRoot,
        stdio: "pipe",
      })
        .toString()
        .trim();

      return sha;
    } finally {
      try {
        fs.unlinkSync(tmpIndex);
      } catch {}
    }
  } catch {
    return undefined;
  }
}
