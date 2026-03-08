// E2E tests for cli-context-detection.feature. Verifies that derive
// infers the git branch from the repository in the current working directory,
// and that it rejects a detached HEAD state with a non-zero exit code.
//
// The detached HEAD test uses execSync("git checkout <hash>") to put the repo
// into detached HEAD state before invoking derive. We assert on exit code and
// the presence of an informative error message.

import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive CLI context detection", () => {
  it("infers the branch from the current git repository and exits cleanly", async () => {
    // The harness creates a repo on "feature-x" and passes that as
    // the cwd when spawning derive. Producing spec files proves derive read the
    // branch from the git repo rather than crashing on context detection.
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --infer-flag to auto-detect settings",
            },
            { type: "assistant", content: "I will add --infer-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);
  }, 30_000);

  it("rejects a detached HEAD with a non-zero exit code and an error message", async () => {
    // --GROK--: Set up a repo on a named branch, then put it into detached HEAD
    // before running derive. derive requires a named branch to scope conversations;
    // a detached HEAD is ambiguous so it must be rejected.
    const { repoDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --detach-flag to work in detached state",
            },
            { type: "assistant", content: "I will add --detach-flag" },
          ],
        },
      ],
    });

    // Detach HEAD: check out the current commit hash directly.
    const hash = execSync("git rev-parse HEAD", { cwd: repoDir }).toString().trim();
    execSync(`git checkout ${hash}`, { cwd: repoDir, stdio: "ignore" });

    const result = await run();

    expect(result.exitCode).not.toBe(0);

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/branch|detached/i);
  }, 30_000);

  it("uses the repository path inferred from the working directory, not a global path", async () => {
    // --GROK--: Two independent harness setups. Each produces spec files in
    // their own repoDir. This confirms derive scopes its context to the CWD
    // rather than reading from a single shared location.
    const { repoDir: repoA, run: runA } = await setupDeriveTest({
      branch: "branch-a",
      conversations: [
        {
          messages: [
            { type: "user", content: "Add --repo-a-flag for repo A features" },
            { type: "assistant", content: "I will add --repo-a-flag" },
          ],
        },
      ],
    });

    const { repoDir: repoB, run: runB } = await setupDeriveTest({
      branch: "branch-b",
      conversations: [
        {
          messages: [
            { type: "user", content: "Add --repo-b-flag for repo B features" },
            { type: "assistant", content: "I will add --repo-b-flag" },
          ],
        },
      ],
    });

    const [resultA, resultB] = await Promise.all([runA(), runB()]);

    expect(resultA.exitCode).toBe(0);
    expect(resultB.exitCode).toBe(0);

    // Each repo must have spec files in its own directory.
    expect(resultA.featureFiles.every((f) => f.startsWith(repoA))).toBe(true);
    expect(resultB.featureFiles.every((f) => f.startsWith(repoB))).toBe(true);
  }, 30_000);
});
