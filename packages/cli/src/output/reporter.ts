import fs from "fs";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepResult {
  name: string;
  status: "passed" | "failed" | "skipped";
}

export interface JobResult {
  name: string;
  workflow: string;
  taskId: string;
  succeeded: boolean;
  durationMs: number;
  debugLogPath: string;
  steps?: StepResult[];
  /** Only set on failure */
  failedStep?: string;
  failedStepLogPath?: string;
  failedExitCode?: number;
  lastOutputLines?: string[];
  /** Number of attempts (only set when > 1, i.e. retried) */
  attempt?: number;
  /** Step outputs captured from $GITHUB_OUTPUT files */
  outputs?: Record<string, string>;
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ─── Failures-first summary (emitted after all jobs complete) ─────────────────

export function printSummary(results: JobResult[], runDir?: string): void {
  const failures = results.filter((r) => !r.succeeded);
  const passes = results.filter((r) => r.succeeded);
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  if (failures.length > 0) {
    process.stdout.write("\n━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
    for (const f of failures) {
      if (f.failedStep) {
        process.stdout.write(`  ✗ ${f.workflow} > ${f.taskId} > "${f.failedStep}"\n`);
      } else {
        process.stdout.write(`  ✗ ${f.workflow} > ${f.taskId}\n`);
      }
      if (f.failedStepLogPath && fs.existsSync(f.failedStepLogPath)) {
        const content = fs.readFileSync(f.failedStepLogPath, "utf-8");
        process.stdout.write("\n" + content);
      } else if (f.lastOutputLines && f.lastOutputLines.length > 0) {
        process.stdout.write("\n" + f.lastOutputLines.join("\n") + "\n");
      }
      process.stdout.write("\n");
    }
  }

  process.stdout.write("\n━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

  const status =
    failures.length > 0
      ? `✗ ${failures.length} failed, ${passes.length} passed`
      : `✓ ${passes.length} passed`;

  process.stdout.write(`  Status:    ${status} (${results.length} total)\n`);
  process.stdout.write(`  Duration:  ${formatDuration(totalMs)}\n`);
  if (runDir) {
    process.stdout.write(`  Root:      ${runDir}\n`);
  }
  process.stdout.write("\n");
}

// ─── Tail helper ──────────────────────────────────────────────────────────────

/** Read the last N lines from a log file. */
export function tailLogFile(filePath: string, lineCount = 20): string[] {
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.slice(-lineCount);
  } catch {
    return [];
  }
}
