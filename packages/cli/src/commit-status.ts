import { execSync } from "child_process";
import { config } from "./config.js";
import type { JobResult } from "./output/reporter.js";

/**
 * Post a GitHub commit status via the `gh` CLI.
 * Requires a GitHub token (opt-in). Prints a warning and skips if no token is provided.
 */
export function postCommitStatus(results: JobResult[], sha?: string, githubToken?: string): void {
  if (!githubToken) {
    console.warn(
      "[Agent CI] Skipping commit status — no GitHub token provided. Use --github-token or set AGENT_CI_GITHUB_TOKEN to post commit statuses.",
    );
    return;
  }

  // Check if gh CLI is available
  try {
    execSync("which gh", { stdio: "ignore" });
  } catch {
    return;
  }

  const resolvedSha =
    sha ||
    (() => {
      try {
        return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
      } catch {
        return undefined;
      }
    })();

  if (!resolvedSha) {
    return;
  }

  const repo = config.GITHUB_REPO;
  if (!repo) {
    return;
  }

  const passed = results.filter((r) => r.succeeded).length;
  const total = results.length;
  const allPassed = passed === total;

  const state = allPassed ? "success" : "failure";
  const description = allPassed
    ? `"It works on my machine!"`
    : `${passed}/${total} jobs passed, ${total - passed} failed`;

  try {
    execSync(
      `gh api repos/${repo}/statuses/${resolvedSha} ` +
        `-f state=${state} ` +
        `-f context=agent-ci ` +
        `-f description=${JSON.stringify(description)} ` +
        `-f target_url=https://agent-ci.dev`,
      { stdio: "ignore" },
    );
  } catch {
    // gh command failed (e.g. no auth, no network) — skip silently
  }
}
