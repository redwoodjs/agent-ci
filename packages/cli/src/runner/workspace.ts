import { execSync } from "child_process";
import { copyWorkspace } from "../output/cleanup.js";
import { findRepoRoot } from "./metadata.js";

// ─── Workspace preparation ────────────────────────────────────────────────────

export interface PrepareWorkspaceOpts {
  workflowPath?: string;
  headSha?: string;
  githubRepo?: string;
  workspaceDir: string;
}

/**
 * Copy source files into the workspace directory, then initialise a fake
 * git repo so `actions/checkout` finds a valid workspace.
 */
export function prepareWorkspace(opts: PrepareWorkspaceOpts): void {
  const { workflowPath, headSha, githubRepo, workspaceDir } = opts;

  // Resolve repo root — needed for both archive and rsync paths.
  // Derive from the workflow path (which lives inside the target repo) so we copy
  // from the correct repo, not from the CLI's CWD (which is agent-ci).
  let repoRoot: string | undefined;
  if (workflowPath) {
    repoRoot = findRepoRoot(workflowPath);
  }
  if (!repoRoot) {
    repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
  }

  if (headSha && headSha !== "HEAD") {
    // Specific SHA requested — use git archive (clean snapshot)
    execSync(`git archive ${headSha} | tar -x -C ${workspaceDir}`, {
      stdio: "pipe",
      cwd: repoRoot,
    });
  } else {
    // Default: copy the working directory as-is, including dirty/untracked files.
    // Uses git ls-files to respect .gitignore (avoids copying node_modules, _/, etc.)
    // On macOS: per-file APFS CoW clones. On Linux: rsync. Fallback: fs.cpSync.
    copyWorkspace(repoRoot, workspaceDir);
  }

  if (githubRepo) {
    initFakeGitRepo(workspaceDir, githubRepo);
  }
}

// ─── Fake git init ────────────────────────────────────────────────────────────

/**
 * Initialise a fake git repository in `dir` so that `actions/checkout`
 * finds a valid workspace with a remote origin and detached HEAD.
 */
export function initFakeGitRepo(dir: string, githubRepo: string): void {
  // The remote URL must exactly match what actions/checkout computes via URL.origin.
  // Node.js URL.origin strips the default port (80), so we must NOT include :80.
  execSync(`git init`, { cwd: dir, stdio: "pipe" });
  execSync(`git config user.name "agent-ci"`, { cwd: dir, stdio: "pipe" });
  execSync(`git config user.email "agent-ci@example.com"`, {
    cwd: dir,
    stdio: "pipe",
  });
  execSync(`git remote add origin http://127.0.0.1/${githubRepo}`, {
    cwd: dir,
    stdio: "pipe",
  });
  execSync(`git add . && git commit -m "workspace" || true`, {
    cwd: dir,
    stdio: "pipe",
  });
  // Create main and refs/remotes/origin/main pointing to this commit
  execSync(`git branch -M main`, { cwd: dir, stdio: "pipe" });
  execSync(`git update-ref refs/remotes/origin/main HEAD`, {
    cwd: dir,
    stdio: "pipe",
  });
  // Detach HEAD so checkout can freely delete ALL branches (it can't delete the current branch)
  execSync(`git checkout --detach HEAD`, { cwd: dir, stdio: "pipe" });
}
