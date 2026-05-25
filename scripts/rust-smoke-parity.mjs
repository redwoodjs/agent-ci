#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBin = path.join(root, "target", "debug", "agent-ci");
const smokeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-rust-smoke-"));
const smokeWorkflowTimeoutMs = 20 * 60 * 1000;
const smokeWorkflowAttempts = 3;

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

function allSmokeWorkflows() {
  return fs
    .readdirSync(path.join(root, ".github/workflows"))
    .filter((file) => file.startsWith("smoke-") && file.endsWith(".yml"))
    .sort()
    .map((file) => ({ path: `.github/workflows/${file}` }));
}

function hasPrivateRemoteAccess() {
  if (process.env.RUST_SMOKE_INCLUDE_PRIVATE === "1") {
    return true;
  }
  const probe = run(
    "gh",
    [
      "api",
      "repos/peterp/agent-ci-private/contents/.github/workflows/lint.yml?ref=cf9992c0af57f77d8ce9d965446dbdb3e062be75",
      "--jq",
      ".sha",
    ],
    {
      stdio: "pipe",
      timeout: 30_000,
    },
  );
  return probe.status === 0;
}

const build = run("cargo", ["build", "-p", "agent-ci"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const includePrivateRemote = hasPrivateRemoteAccess();
for (const workflow of allSmokeWorkflows()) {
  if (workflow.path.endsWith("smoke-remote-private-workflow.yml") && !includePrivateRemote) {
    console.log(`↷ ${workflow.path} skipped: private fixture is not accessible to this token`);
    continue;
  }
  if (workflow.path.endsWith("smoke-bun-setup.yml") && process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `↷ ${workflow.path} skipped on GitHub: the nested bun launcher stalls under Rust parity; the standalone smoke-bun-setup check covers it directly`,
    );
    continue;
  }
  let result;
  for (let attempt = 1; attempt <= smokeWorkflowAttempts; attempt += 1) {
    const workflowWorkDir = path.join(
      smokeWorkDir,
      `${workflow.path.replaceAll(/[^a-zA-Z0-9]+/g, "-")}-${attempt}`,
    );
    result = run(rustBin, ["run", "--workflow", workflow.path, "--quiet", "--jobs", "2"], {
      env: { AGENT_CI_WORKING_DIR: workflowWorkDir },
      stdio: "inherit",
      timeout: smokeWorkflowTimeoutMs,
    });
    if (result.status === 0) {
      break;
    }
    if (attempt < smokeWorkflowAttempts) {
      console.log(`↻ ${workflow.path} retrying after failed attempt ${attempt}`);
    }
  }
  assertSuccess(result, workflow.path);
  console.log(`✓ ${workflow.path} executed successfully`);
}

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
