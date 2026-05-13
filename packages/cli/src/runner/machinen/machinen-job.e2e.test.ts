// End-to-end smoke for the machinen runtime.
//
// Spawns the CLI as a child process — exactly what a user runs — with
// `AGENT_CI_MACHINEN=1`, against a tiny generated workflow. Asserts
// the run completes successfully.
//
// Skipped unless ALL of:
//   - arm64 darwin/linux host (machinen's only supported platforms)
//   - `AGENT_CI_MACHINEN_E2E=1` env (opt-in; the test takes ~30s,
//     needs a working machinen install, and isn't free)
//   - A baked rootfs available locally (either the official cached
//     download at ~/.cache/agent-ci/machinen/base.tar.gz, OR any
//     `rootfs-*.tar.gz` left over from a prior bake)
//
// The test reuses the cached rootfs as a per-repo override file
// (`.github/agent-ci.machinen.tar.gz`) so it doesn't need network
// access for the rootfs itself. The runtime still needs
// `@machinen/runtime`, the VMM binaries (chmod'd executable — see
// redwoodjs/machinen#309), and the kernel + dtb base assets in
// `~/.machinen/runtime-v<ver>/bases/`.

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileP = promisify(execFile);

function findCachedRootfs(): string | null {
  const cacheRoot = path.join(os.homedir(), ".cache", "agent-ci", "machinen");
  if (!existsSync(cacheRoot)) {
    return null;
  }
  const base = path.join(cacheRoot, "base.tar.gz");
  if (existsSync(base)) {
    return base;
  }
  const entries = readdirSync(cacheRoot)
    .filter((n) => n.startsWith("rootfs-") && n.endsWith(".tar.gz"))
    .sort();
  return entries.length > 0 ? path.join(cacheRoot, entries[0]) : null;
}

const ROOTFS = findCachedRootfs();
const SHOULD_RUN =
  process.env.AGENT_CI_MACHINEN_E2E === "1" &&
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  ROOTFS !== null;

describe.skipIf(!SHOULD_RUN)("machinen e2e (real VM)", () => {
  it("boots, runs a tiny workflow inside the guest, exits successfully", async () => {
    // ── Build a self-contained test repo with the override rootfs ───
    const repoRoot = mkdtempSync(path.join(os.tmpdir(), "machinen-e2e-"));
    try {
      const workflowsDir = path.join(repoRoot, ".github", "workflows");
      await fsp.mkdir(workflowsDir, { recursive: true });
      // Drop the override rootfs so we don't depend on network.
      await fsp.copyFile(ROOTFS!, path.join(repoRoot, ".github", "agent-ci.machinen.tar.gz"));
      writeFileSync(
        path.join(workflowsDir, "smoke.yml"),
        [
          "name: smoke",
          "on: push",
          "jobs:",
          "  hello:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo hello-from-machinen-e2e",
        ].join("\n") + "\n",
      );

      // Minimal git so resolveRepoSlug + resolveHeadSha succeed. The
      // CLI reads HEAD and the remote slug at startup; without a real
      // commit it errors out before reaching the runtime selector.
      await execFileP("git", ["init", "-q", "-b", "main"], { cwd: repoRoot });
      await execFileP("git", ["remote", "add", "origin", "https://github.com/test/repo.git"], {
        cwd: repoRoot,
      });
      await execFileP("git", ["add", "-A"], { cwd: repoRoot });
      await execFileP(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"],
        { cwd: repoRoot },
      );

      const cliPath = path.resolve(
        path.dirname(new URL(import.meta.url).pathname),
        "../../../../cli/src/cli.ts",
      );

      // ── Run the CLI through machinen ──────────────────────────────
      const { stdout, stderr } = await execFileP(
        "node",
        [
          cliPath,
          "run",
          "--workflow",
          path.join(workflowsDir, "smoke.yml"),
          "--working-directory",
          repoRoot,
        ],
        {
          env: {
            ...process.env,
            AGENT_CI_MACHINEN: "1",
            GITHUB_REPO: "test/repo",
          },
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );

      // The CLI's summary section is the contract a user reads. Look
      // for "1 passed" in the standard summary block.
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toMatch(/1 passed/);
    } finally {
      await fsp.rm(repoRoot, { recursive: true, force: true });
    }
  }, 180_000);
});
