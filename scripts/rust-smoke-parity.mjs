#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBin = path.join(root, "target", "debug", "agent-ci");
const smokeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-rust-smoke-"));
const smokeWorkflows = [
  { path: ".github/workflows/smoke-binary.yml" },
  { path: ".github/workflows/smoke-expressions.yml" },
  { path: ".github/workflows/smoke-matrix.yml" },
  { path: ".github/workflows/smoke-artifacts.yml" },
  { path: ".github/workflows/smoke-docker-buildx.yml" },
  { path: ".github/workflows/smoke-pause-pipe.yml" },
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
  });
}

const build = run("cargo", ["build", "-p", "agent-ci"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

for (const workflow of smokeWorkflows) {
  const workflowWorkDir = path.join(smokeWorkDir, workflow.path.replaceAll(/[^a-zA-Z0-9]+/g, "-"));
  const result = run(rustBin, ["run", "--workflow", workflow.path, "--quiet"], {
    env: { AGENT_CI_WORKING_DIR: workflowWorkDir },
  });
  if (result.status !== 0) {
    throw new Error(
      `${workflow.path}: expected Rust smoke execution to succeed, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  if (result.stderr.includes("Rust workflow execution is not implemented yet")) {
    throw new Error(
      `${workflow.path}: Rust execution still reports the tracked gap\n${result.stderr}`,
    );
  }
  console.log(`✓ ${workflow.path} executed successfully`);
}
