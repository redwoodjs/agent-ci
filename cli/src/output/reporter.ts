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

// ─── Single-line status (emitted as each job finishes) ────────────────────────

export function printJobStatus(result: JobResult): void {
  const icon = result.succeeded ? "✓" : "✗";
  const dur = formatDuration(result.durationMs);
  const label = `${result.workflow} > ${result.taskId}`;
  process.stdout.write(`  ${icon} ${label} (${dur})\n`);
}

export function printJobStarted(workflow: string, taskId: string): void {
  process.stdout.write(`  ● ${workflow} > ${taskId} (running)\n`);
}

// ─── Failures-first summary (emitted after all jobs complete) ─────────────────

export function printSummary(results: JobResult[]): void {
  const failures = results.filter((r) => !r.succeeded);
  const passes = results.filter((r) => r.succeeded);
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  if (failures.length > 0) {
    process.stdout.write("\n━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");
    for (const f of failures) {
      if (f.failedStep) {
        process.stdout.write(`  ✗ ${f.workflow} > ${f.taskId} > "${f.failedStep}"\n`);
      } else {
        process.stdout.write(`  ✗ ${f.workflow} > ${f.taskId}\n`);
      }
      if (f.failedExitCode !== undefined) {
        process.stdout.write(`    Exit code: ${f.failedExitCode}\n`);
      }
      if (f.lastOutputLines && f.lastOutputLines.length > 0) {
        process.stdout.write(`    Last output:\n`);
        for (const line of f.lastOutputLines) {
          process.stdout.write(`      ${line}\n`);
        }
      }
      process.stdout.write("\n");
    }
  }

  process.stdout.write("\n━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

  const tally = [
    failures.length > 0 ? `✗ ${failures.length} failed` : null,
    passes.length > 0 ? `✓ ${passes.length} passed` : null,
  ]
    .filter(Boolean)
    .join(", ");

  process.stdout.write(`  ${tally}, ${results.length} total (${formatDuration(totalMs)})\n\n`);
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
