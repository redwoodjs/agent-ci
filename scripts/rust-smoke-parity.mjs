#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBin = path.join(root, "target", "debug", "agent-ci");
const smokeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-rust-smoke-"));
const smokeWorkflowTimeoutMs = 10 * 60 * 1000;
const smokeWorkflows = [
  { path: ".github/workflows/smoke-binary.yml" },
  { path: ".github/workflows/smoke-expressions.yml" },
  { path: ".github/workflows/smoke-matrix.yml" },
  { path: ".github/workflows/smoke-artifacts.yml" },
  // smoke-pause-pipe.yml intentionally stays out of this nested Rust parity
  // loop: it exercises the TypeScript dev launcher in a pipe and can block the
  // parent Rust runner while the child waits for a retry/abort signal. The
  // standalone smoke workflow continues to cover issue #315 directly.
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
  });
}

function assertSuccess(result, label) {
  if (result.status === 0) {
    return;
  }
  const cause = result.error ? ` (${result.error.message})` : "";
  const signal = result.signal ? `, signal ${result.signal}` : "";
  throw new Error(
    `${label}: expected Rust smoke execution to succeed, got ${result.status}${signal}${cause}`,
  );
}

const build = run("cargo", ["build", "-p", "agent-ci"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

for (const workflow of smokeWorkflows) {
  const workflowWorkDir = path.join(smokeWorkDir, workflow.path.replaceAll(/[^a-zA-Z0-9]+/g, "-"));
  const result = run(rustBin, ["run", "--workflow", workflow.path, "--quiet", "--jobs", "2"], {
    env: { AGENT_CI_WORKING_DIR: workflowWorkDir },
    stdio: "inherit",
    timeout: smokeWorkflowTimeoutMs,
  });
  assertSuccess(result, workflow.path);
  console.log(`✓ ${workflow.path} executed successfully`);
}

const buildxRepo = path.join(smokeWorkDir, "docker-buildx-repo");
fs.mkdirSync(path.join(buildxRepo, ".github/workflows"), { recursive: true });
run("git", ["init"], { cwd: buildxRepo });
run("git", ["remote", "add", "origin", "https://github.com/test-org/docker-buildx-repro.git"], {
  cwd: buildxRepo,
});
fs.writeFileSync(path.join(buildxRepo, "README.md"), "docker buildx smoke\n");
fs.writeFileSync(
  path.join(buildxRepo, ".github/workflows/test.yml"),
  `name: Test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd # v4.0.0
      - name: Verify buildx
        run: |
          docker buildx version
          docker buildx ls
          echo "buildx is working"
`,
);
run("git", ["add", "."], { cwd: buildxRepo });
run("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
  cwd: buildxRepo,
});
const buildxResult = spawnSync(
  rustBin,
  ["run", "--workflow", ".github/workflows/test.yml", "--quiet", "--jobs", "2"],
  {
    cwd: buildxRepo,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_CI_WORKING_DIR: path.join(smokeWorkDir, "docker-buildx-work"),
    },
    stdio: "inherit",
    timeout: smokeWorkflowTimeoutMs,
  },
);
assertSuccess(buildxResult, "docker buildx smoke");
console.log("✓ docker buildx smoke executed successfully");

const allRepo = path.join(smokeWorkDir, "all-mode-repo");
fs.mkdirSync(path.join(allRepo, ".github/workflows"), { recursive: true });
run("git", ["init"], { cwd: allRepo });
fs.writeFileSync(path.join(allRepo, "README.md"), "all smoke\n");
fs.writeFileSync(
  path.join(allRepo, ".github/workflows/one.yml"),
  "on: workflow_dispatch\njobs:\n  one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo one\n",
);
fs.writeFileSync(
  path.join(allRepo, ".github/workflows/two.yml"),
  "on: workflow_dispatch\njobs:\n  two:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo two\n",
);
run("git", ["add", "."], { cwd: allRepo });
run("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"], {
  cwd: allRepo,
});
const allResult = spawnSync(rustBin, ["run", "--all", "--quiet", "--jobs", "2"], {
  cwd: allRepo,
  encoding: "utf8",
  env: {
    ...process.env,
    AGENT_CI_WORKING_DIR: path.join(smokeWorkDir, "all-mode-work"),
  },
  stdio: "inherit",
  timeout: smokeWorkflowTimeoutMs,
});
assertSuccess(allResult, "--all smoke");
console.log("✓ --all smoke executed successfully");
