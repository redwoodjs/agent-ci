#!/usr/bin/env node
// Bake the machinen rootfs that agent-ci publishes as a GitHub Release
// asset. Release-only tooling — not used by the CLI at runtime.
//
// Boots a debian-arm64 base VM via @machinen/runtime.provision(), apt-installs
// the package set agent-ci needs, downloads + extracts the GHA runner binary,
// and writes the result to a tarball machinen.boot() can consume directly.
// See docs/adr/0004-machinen-rootfs-as-release-asset.md.
//
// Usage:
//   node scripts/machinen-bake.mjs [--out <path>]
//
// Output defaults to dist/agent-ci-machinen-runner-arm64.tar.gz at repo root.
// The release workflow uploads that file to the `machinen-rootfs-latest`
// GitHub release.
//
// Requirements:
//   - Host is arm64 darwin or arm64 linux (so machinen's VMM bindings load).
//   - `@machinen/cli` has been run at least once on this host so the base
//     debian-arm64 assets exist at ~/.machinen/runtime-v<ver>/bases/, or
//     MACHINEN_ASSETS_DIR points at a directory with them.

import { mkdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Pinned alongside DEFAULT_MACOS_RUNNER_VERSION in
// packages/cli/src/runner/macos-vm/runner-binary.ts.
const RUNNER_VERSION = "2.331.0";
const RUNNER_URL = `https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-arm64-${RUNNER_VERSION}.tar.gz`;

// Mirrors what ghcr.io/actions/actions-runner:latest itself ships so
// workflows see the same baseline regardless of runtime.
const APT_PACKAGES = ["nodejs", "git", "curl", "ca-certificates", "jq", "unzip"];

// Where the runner binary lands inside the baked rootfs. Matches the
// upstream actions-runner image convention.
const GUEST_RUNNER_DIR = "/home/runner";

const args = process.argv.slice(2);
let outPath = resolve(repoRoot, "dist/agent-ci-machinen-runner-arm64.tar.gz");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out" && args[i + 1]) {
    outPath = resolve(args[++i]);
  } else if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(
      "Usage: node scripts/machinen-bake.mjs [--out <path>]\n" +
        "Default --out: dist/agent-ci-machinen-runner-arm64.tar.gz\n",
    );
    process.exit(0);
  }
}

await mkdir(dirname(outPath), { recursive: true });

const mod = await import("@machinen/runtime").catch((err) => {
  process.stderr.write(
    `failed to load @machinen/runtime: ${err?.message ?? err}\n` +
      "Run `pnpm install` (the package is an optionalDependency of @redwoodjs/agent-ci).\n",
  );
  process.exit(1);
});

const installCmds = [
  "set -e",
  "export DEBIAN_FRONTEND=noninteractive",
  "apt-get update",
  `apt-get install -y --no-install-recommends ${APT_PACKAGES.join(" ")}`,
  `mkdir -p ${GUEST_RUNNER_DIR}`,
  `curl -fsSL ${RUNNER_URL} -o /tmp/actions-runner.tar.gz`,
  `tar -xzf /tmp/actions-runner.tar.gz -C ${GUEST_RUNNER_DIR}`,
  "rm -f /tmp/actions-runner.tar.gz",
  "apt-get clean",
  "rm -rf /var/lib/apt/lists/*",
].join("\n");

process.stderr.write(`machinen-bake: writing ${outPath}\n`);
const t0 = Date.now();

await mod.provision({
  out: outPath,
  install: async (vm) => {
    const result = await vm.exec(installCmds, { execTimeoutMs: 10 * 60 * 1000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `install hook failed with exit code ${result.exitCode}.\n` +
          `stderr (tail): ${result.stderr.slice(-2048)}`,
      );
    }
  },
});

const { size } = await stat(outPath);
const mb = (size / (1024 * 1024)).toFixed(1);
process.stderr.write(`machinen-bake: ok in ${Date.now() - t0}ms — ${mb} MB at ${outPath}\n`);
