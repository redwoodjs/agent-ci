#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustBin = path.join(root, "target", "debug", "agent-ci");
const smokeWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-rust-smoke-"));
const smokeWorkflowTimeoutMs = Number(
  process.env.RUST_SMOKE_TIMEOUT_MS ?? (process.env.GITHUB_ACTIONS === "true" ? 5 : 20) * 60 * 1000,
);
const smokeWorkflowAttempts = Number(process.env.RUST_SMOKE_ATTEMPTS ?? 1);
const tailLineLimit = Number(process.env.RUST_SMOKE_TAIL_LINES ?? 200);
const logTailLineLimit = Number(process.env.RUST_SMOKE_LOG_TAIL_LINES ?? 120);
const results = [];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "pipe",
    timeout: options.timeout,
  });
}

function runStreaming(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const outputLines = [];
    let buffered = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const remember = (chunk, stream) => {
      const text = chunk.toString();
      stream.write(text);
      buffered += text;
      const parts = buffered.split(/\r?\n/);
      buffered = parts.pop() ?? "";
      for (const line of parts) {
        outputLines.push(line);
      }
      while (outputLines.length > tailLineLimit) {
        outputLines.shift();
      }
    };

    child.stdout.on("data", (chunk) => remember(chunk, process.stdout));
    child.stderr.on("data", (chunk) => remember(chunk, process.stderr));
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status: null,
        signal: null,
        error,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: [...outputLines, buffered].filter(Boolean),
      });
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        status,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        outputTail: [...outputLines, buffered].filter(Boolean),
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL");
        }
      }, 10_000).unref();
    }, options.timeout ?? smokeWorkflowTimeoutMs);
  });
}

function resultLabel(result) {
  const cause = result.error ? ` (${result.error.message})` : "";
  const signal = result.signal ? `, signal ${result.signal}` : "";
  const timeout = result.timedOut ? ", timed out" : "";
  return `${result.status}${signal}${timeout}${cause}`;
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

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function readTail(file, maxLines) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-maxLines).join("\n");
  } catch (error) {
    return `<failed to read ${file}: ${error.message}>`;
  }
}

function collectFiles(dir, depth = 0) {
  if (depth > 2) {
    return [];
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(full, depth + 1);
    }
    if (entry.isFile()) {
      return [full];
    }
    return [];
  });
}

function logDirsFromTail(lines) {
  return [
    ...new Set(
      lines
        .map((line) => line.match(/Logs:\s+(\S+)/)?.[1])
        .filter(Boolean)
        .filter((dir) => fs.existsSync(dir)),
    ),
  ];
}

function printFailureDiagnostics(workflowPath, attempt, result) {
  console.error(`::group::Rust smoke diagnostics: ${workflowPath} attempt ${attempt}`);
  console.error(`result=${resultLabel(result)} duration=${formatDuration(result.durationMs)}`);
  console.error("--- captured output tail ---");
  console.error(result.outputTail.join("\n") || "<empty>");

  for (const dir of logDirsFromTail(result.outputTail)) {
    console.error(`--- runner log dir: ${dir} ---`);
    for (const file of collectFiles(dir).sort()) {
      console.error(`--- tail ${file} ---`);
      console.error(readTail(file, logTailLineLimit));
    }
  }

  console.error("--- docker agent-ci containers ---");
  run(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      "name=agent-ci",
      "--format",
      "table {{.Names}}\t{{.Status}}\t{{.Image}}",
    ],
    { stdio: "inherit", timeout: 30_000 },
  );
  console.error("::endgroup::");
}

const build = run("cargo", ["build", "-p", "agent-ci"], { stdio: "inherit" });
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const includePrivateRemote = hasPrivateRemoteAccess();
for (const workflow of allSmokeWorkflows()) {
  if (workflow.path.endsWith("smoke-remote-private-workflow.yml") && !includePrivateRemote) {
    console.log(`↷ ${workflow.path} skipped: private fixture is not accessible to this token`);
    results.push({
      workflow: workflow.path,
      status: "skipped",
      reason: "private fixture inaccessible",
    });
    continue;
  }
  if (workflow.path.endsWith("smoke-bun-setup.yml") && process.env.GITHUB_ACTIONS === "true") {
    console.log(
      `↷ ${workflow.path} skipped on GitHub: the nested bun launcher stalls under Rust parity; the standalone smoke-bun-setup check covers it directly`,
    );
    results.push({
      workflow: workflow.path,
      status: "skipped",
      reason: "standalone GitHub smoke covers it",
    });
    continue;
  }

  let passed = false;
  let finalResult;
  for (let attempt = 1; attempt <= smokeWorkflowAttempts; attempt += 1) {
    const workflowWorkDir = path.join(
      smokeWorkDir,
      `${workflow.path.replaceAll(/[^a-zA-Z0-9]+/g, "-")}-${attempt}`,
    );
    console.log(
      `::group::Rust smoke parity: ${workflow.path} attempt ${attempt}/${smokeWorkflowAttempts}`,
    );
    console.log(`▶ start ${workflow.path} attempt=${attempt} timeoutMs=${smokeWorkflowTimeoutMs}`);
    const result = await runStreaming(
      rustBin,
      ["run", "--workflow", workflow.path, "--quiet", "--jobs", "2"],
      {
        env: { AGENT_CI_WORKING_DIR: workflowWorkDir },
        timeout: smokeWorkflowTimeoutMs,
      },
    );
    console.log(
      `▶ finish ${workflow.path} attempt=${attempt} result=${resultLabel(result)} duration=${formatDuration(result.durationMs)}`,
    );
    console.log("::endgroup::");
    finalResult = result;
    if (result.status === 0) {
      passed = true;
      results.push({
        workflow: workflow.path,
        status: "passed",
        attempts: attempt,
        durationMs: result.durationMs,
      });
      console.log(`✓ ${workflow.path} executed successfully`);
      break;
    }
    printFailureDiagnostics(workflow.path, attempt, result);
    if (attempt < smokeWorkflowAttempts) {
      console.log(`↻ ${workflow.path} retrying after failed attempt ${attempt}`);
    }
  }
  if (!passed) {
    results.push({
      workflow: workflow.path,
      status: "failed",
      attempts: smokeWorkflowAttempts,
      durationMs: finalResult?.durationMs ?? 0,
      result: finalResult ? resultLabel(finalResult) : "unknown",
    });
  }
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
const allStart = Date.now();
const allResult = await runStreaming(rustBin, ["run", "--all", "--quiet", "--jobs", "2"], {
  cwd: allRepo,
  env: {
    AGENT_CI_WORKING_DIR: path.join(smokeWorkDir, "all-mode-work"),
  },
  timeout: smokeWorkflowTimeoutMs,
});
if (allResult.status === 0) {
  results.push({
    workflow: "--all smoke",
    status: "passed",
    attempts: 1,
    durationMs: Date.now() - allStart,
  });
  console.log("✓ --all smoke executed successfully");
} else {
  results.push({
    workflow: "--all smoke",
    status: "failed",
    attempts: 1,
    durationMs: Date.now() - allStart,
    result: resultLabel(allResult),
  });
  printFailureDiagnostics("--all smoke", 1, allResult);
}

console.log("\n━━━ RUST SMOKE PARITY ATTEMPT SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━");
for (const result of results) {
  console.log(
    `${result.status.padEnd(7)} ${String(result.attempts ?? "-").padStart(2)} attempt(s) ${formatDuration(result.durationMs ?? 0).padStart(7)} ${result.workflow}${result.reason ? ` (${result.reason})` : ""}${result.result ? ` => ${result.result}` : ""}`,
  );
}

const failures = results.filter((result) => result.status === "failed");
if (failures.length > 0) {
  throw new Error(
    `Rust smoke parity failed for ${failures.map((result) => result.workflow).join(", ")}`,
  );
}
