/**
 * Step executor — runs individual workflow steps.
 *
 * Handles `run:` (script) steps. Action steps (`uses:`) are handled
 * by action-executor.ts (Phase 2).
 */

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import {
  type WorkflowCommands,
  createEmptyCommands,
  parseCommand,
  parseKeyValueFile,
  parsePathFile,
} from "./commands.js";
import { interpolate, evaluateCondition } from "./expressions.js";
import type { Step, StepResult, StepOutputs, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/**
 * Execute a single step. Returns the result including outputs, env updates,
 * and path additions.
 */
export async function executeStep(step: Step, ctx: RunContext): Promise<StepResult> {
  // Evaluate `if:` condition (defaults to `success()` when not specified)
  const condition = step.if ?? "success()";
  const shouldRun = evaluateCondition(condition, ctx.expressionCtx);
  if (!shouldRun) {
    return {
      id: step.id,
      name: step.name,
      outcome: "skipped",
      conclusion: "skipped",
      outputs: {},
      envUpdates: {},
      pathUpdates: [],
      durationMs: 0,
    };
  }

  const startTime = Date.now();

  if (step.type === "script") {
    const result = await executeScriptStep(step, ctx);
    result.durationMs = Date.now() - startTime;
    return result;
  }

  if (step.type === "action") {
    // Phase 2 — for now, skip action steps with a warning
    ctx.onOutput?.(`[ts-runner] Skipping action step: ${step.uses} (not yet supported)\n`);
    return {
      id: step.id,
      name: step.name,
      outcome: "skipped",
      conclusion: "skipped",
      outputs: {},
      envUpdates: {},
      pathUpdates: [],
      durationMs: Date.now() - startTime,
    };
  }

  throw new Error(`Unknown step type: ${(step as any).type}`);
}

// ---------------------------------------------------------------------------
// Script step execution
// ---------------------------------------------------------------------------

async function executeScriptStep(
  step: Step & { type: "script" },
  ctx: RunContext,
): Promise<StepResult> {
  // Set up temp files for file-based commands
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-"));
  const outputFile = path.join(tmpDir, "output");
  const envFile = path.join(tmpDir, "env");
  const pathFile = path.join(tmpDir, "path");
  const stateFile = path.join(tmpDir, "state");
  const summaryFile = path.join(tmpDir, "summary");

  // Create empty files
  for (const f of [outputFile, envFile, pathFile, stateFile, summaryFile]) {
    fs.writeFileSync(f, "");
  }

  // Build environment
  const stepEnv = step.env
    ? Object.fromEntries(
        Object.entries(step.env).map(([k, v]) => [k, interpolate(v, ctx.expressionCtx)]),
      )
    : {};

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Standard GitHub Actions env vars
    CI: "true",
    GITHUB_ACTIONS: "true",
    GITHUB_WORKSPACE: ctx.workspace,
    GITHUB_OUTPUT: outputFile,
    GITHUB_ENV: envFile,
    GITHUB_PATH: pathFile,
    GITHUB_STATE: stateFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    // Merge global env, then step env (step wins)
    ...ctx.expressionCtx.env,
    ...stepEnv,
  };

  // PATH additions from previous steps
  if (ctx.extraPath.length > 0) {
    env.PATH = [...ctx.extraPath, env.PATH || ""].join(path.delimiter);
  }

  // Interpolate the script
  const script = interpolate(step.run!, ctx.expressionCtx);

  // Determine shell
  const shell = step.shell ?? "bash";
  const workingDir = step.workingDirectory
    ? path.resolve(ctx.workspace, interpolate(step.workingDirectory, ctx.expressionCtx))
    : ctx.workspace;

  // Write script to temp file
  const scriptFile = path.join(
    tmpDir,
    shell === "pwsh" || shell === "powershell" ? "step.ps1" : "step.sh",
  );
  fs.writeFileSync(scriptFile, script, { mode: 0o755 });

  // Build shell command
  const shellCmd = buildShellCommand(shell, scriptFile);

  // Execute
  const commands = createEmptyCommands();
  const exitCode = await runProcess(shellCmd, {
    env,
    cwd: workingDir,
    commands,
    onOutput: ctx.onOutput,
    timeoutMs: step.timeoutMinutes ? step.timeoutMinutes * 60_000 : undefined,
  });

  // Read file-based outputs
  const fileOutputs = parseKeyValueFile(outputFile);
  const fileEnv = parseKeyValueFile(envFile);
  const filePath = parsePathFile(pathFile);

  // Merge outputs from both :: commands and file commands
  const outputs: StepOutputs = { ...commands.outputs, ...fileOutputs };
  const envUpdates = { ...commands.env, ...fileEnv };
  const pathUpdates = [...commands.path, ...filePath];

  // Clean up temp files
  try {
    fs.rmSync(tmpDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }

  const outcome = exitCode === 0 ? "success" : "failure";
  const continueOnError = step.continueOnError ?? false;

  return {
    id: step.id,
    name: step.name,
    outcome,
    conclusion: continueOnError && outcome === "failure" ? "success" : outcome,
    exitCode,
    outputs,
    envUpdates,
    pathUpdates,
    annotations: commands.annotations,
    durationMs: 0, // set by caller
  };
}

// ---------------------------------------------------------------------------
// Shell command builders
// ---------------------------------------------------------------------------

function buildShellCommand(shell: string, scriptFile: string): string[] {
  switch (shell) {
    case "bash":
      return ["bash", "--noprofile", "--norc", "-eo", "pipefail", scriptFile];
    case "sh":
      return ["sh", "-e", scriptFile];
    case "pwsh":
    case "powershell":
      return ["pwsh", "-command", `. '${scriptFile}'`];
    case "python":
      return ["python", scriptFile];
    case "node":
      return ["node", scriptFile];
    default:
      // Custom shell: replace {0} with script path
      if (shell.includes("{0}")) {
        const cmd = shell.replace("{0}", scriptFile);
        return ["bash", "-c", cmd];
      }
      return [shell, scriptFile];
  }
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

interface RunOptions {
  env: Record<string, string>;
  cwd: string;
  commands: WorkflowCommands;
  onOutput?: (line: string) => void;
  timeoutMs?: number;
}

function runProcess(args: string[], opts: RunOptions): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = args;
    const proc = spawn(cmd, rest, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 5_000);
      }, opts.timeoutMs);
    }

    let stdoutRemainder = "";
    let stderrRemainder = "";

    const processLines = (text: string, remainder: string): [string] | [string, string] => {
      const combined = remainder + text;
      const lines = combined.split("\n");
      const incomplete = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") {
          continue;
        }
        const display = parseCommand(line, opts.commands);
        if (display !== null && opts.onOutput) {
          opts.onOutput(display);
        }
      }
      return [incomplete];
    };

    const flushRemainder = (remainder: string) => {
      if (remainder) {
        const display = parseCommand(remainder, opts.commands);
        if (display !== null && opts.onOutput) {
          opts.onOutput(display);
        }
      }
    };

    proc.stdout.on("data", (data: Buffer) => {
      const [incomplete] = processLines(data.toString(), stdoutRemainder);
      stdoutRemainder = incomplete;
    });
    proc.stderr.on("data", (data: Buffer) => {
      const [incomplete] = processLines(data.toString(), stderrRemainder);
      stderrRemainder = incomplete;
    });

    proc.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(err);
    });

    proc.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      flushRemainder(stdoutRemainder);
      flushRemainder(stderrRemainder);
      resolve(code ?? 1);
    });
  });
}
