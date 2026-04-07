#!/usr/bin/env node

/**
 * ts-runner CLI — run GitHub Actions workflows locally without Docker.
 *
 * Usage:
 *   ts-runner <workflow.yml> [options]
 *
 * Options:
 *   --workspace <path>   Workspace root (default: cwd)
 *   --secret KEY=VALUE   Set a secret (can be repeated)
 *   --env KEY=VALUE      Set an env var (can be repeated)
 *   --force              Ignore job-level if: conditions (run everything)
 *   --quiet              Only show step names and status, not output
 */

import path from "path";
import { runWorkflow } from "./runner.js";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`
ts-runner — Run GitHub Actions workflows locally without Docker.

Usage:
  ts-runner <workflow.yml> [options]

Options:
  --workspace <path>   Workspace root (default: current directory)
  --secret KEY=VALUE   Set a secret (repeatable)
  --env KEY=VALUE      Set an env var (repeatable)
  --force              Ignore job-level if: conditions (run everything)
  --quiet              Suppress step output, show status only
  --help               Show this help
`);
  process.exit(0);
}

// Parse args
let workflowPath: string | undefined;
let workspace = process.cwd();
const secrets: Record<string, string> = {};
const env: Record<string, string> = {};
let quiet = false;
let force = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--workspace" && i + 1 < args.length) {
    workspace = path.resolve(args[++i]);
  } else if (arg === "--secret" && i + 1 < args.length) {
    const [key, ...rest] = args[++i].split("=");
    secrets[key] = rest.join("=");
  } else if (arg === "--env" && i + 1 < args.length) {
    const [key, ...rest] = args[++i].split("=");
    env[key] = rest.join("=");
  } else if (arg === "--force") {
    force = true;
  } else if (arg === "--quiet") {
    quiet = true;
  } else if (!arg.startsWith("-")) {
    workflowPath = path.resolve(arg);
  }
}

if (!workflowPath) {
  console.error("Error: No workflow file specified.");
  process.exit(1);
}

// Colors (basic ANSI)
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

const result = await runWorkflow({
  workflowPath,
  workspace,
  secrets,
  env,
  force,
  onOutput: quiet ? undefined : (line) => console.log(dim(`  │ ${line}`)),
  onJobStart: (job) => {
    console.log(`\n${bold(job.name)}`);
  },
  onStepStart: (info) => {
    if (!quiet) {
      process.stdout.write(`  ${dim("▶")} ${info.stepName}`);
    }
  },
  onStepEnd: (info) => {
    const duration = dim(formatDuration(info.durationMs));
    if (info.outcome === "success") {
      if (quiet) {
        console.log(`  ${green("✓")} ${info.stepId} ${duration}`);
      } else {
        process.stdout.write(` ${green("✓")} ${duration}\n`);
      }
    } else if (info.outcome === "failure") {
      if (quiet) {
        console.log(`  ${red("✗")} ${info.stepId} ${duration}`);
      } else {
        process.stdout.write(` ${red("✗")} ${duration}\n`);
      }
    } else {
      if (quiet) {
        console.log(`  ${yellow("○")} ${info.stepId} ${dim("skipped")}`);
      } else {
        process.stdout.write(` ${yellow("○ skipped")}\n`);
      }
    }
  },
  onJobEnd: (job) => {
    const status =
      job.status === "success"
        ? green("passed")
        : job.status === "failure"
          ? red("failed")
          : yellow("skipped");
    console.log(`  ${dim("└")} ${status} ${dim(formatDuration(job.durationMs))}`);
  },
});

// Summary
console.log(`\n${dim("─".repeat(40))}`);
console.log(
  `${bold(result.name)} — ${result.status === "success" ? green("passed") : red("failed")} ${dim(formatDuration(result.durationMs))}`,
);

process.exit(result.status === "success" ? 0 : 1);
