import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { copyWorkspace } from "../output/cleanup.js";
import { findRepoRoot } from "./metadata.js";
import { config } from "../config.js";

export interface PrepareWorkspaceOpts {
  workflowPath?: string;
  headSha?: string;
  githubRepo?: string;
  workspaceDir: string;
}

export function prepareWorkspace(opts: PrepareWorkspaceOpts): void {
  const { workflowPath, headSha, githubRepo, workspaceDir } = opts;

  // Resolve repo root from workflow path first so we always copy from the
  // target repository (not from the CLI process cwd).
  let repoRoot: string | undefined;
  if (workflowPath) {
    repoRoot = findRepoRoot(workflowPath);
  }
  if (!repoRoot) {
    repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
  }

  if (headSha && headSha !== "HEAD") {
    // Snapshot mode: materialize the exact commit into the workspace.
    execSync(`git archive ${headSha} | tar -x -C ${workspaceDir}`, {
      stdio: "pipe",
      cwd: repoRoot,
    });
  } else {
    // Live mode: include tracked + untracked non-ignored files from disk.
    copyWorkspace(repoRoot, workspaceDir);
  }

  if (workflowPath && fs.existsSync(workflowPath)) {
    // Always copy the selected workflow file from disk so parser/runtime changes
    // to the workflow are visible even when the workspace came from git archive.
    const relativeWorkflowPath = path.relative(repoRoot, workflowPath);
    if (relativeWorkflowPath.startsWith("..") || path.isAbsolute(relativeWorkflowPath)) {
      console.warn(`[Agent CI] Skipping workflow copy outside repo root: ${workflowPath}`);
    } else {
      const destWorkflowPath = path.join(workspaceDir, relativeWorkflowPath);
      try {
        fs.mkdirSync(path.dirname(destWorkflowPath), { recursive: true });
        fs.copyFileSync(workflowPath, destWorkflowPath);
      } catch (error) {
        console.warn(`[Agent CI] Failed to copy workflow into workspace: ${error}`);
      }
    }
  }

  initFakeGitRepo(workspaceDir, githubRepo || config.GITHUB_REPO);
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
