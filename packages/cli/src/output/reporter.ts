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
  /** Optional actionable hint attached to a failure (e.g. missing system tool) */
  hint?: string;
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

function getErrorContent(f: JobResult): string {
  if (f.failedStepLogPath && fs.existsSync(f.failedStepLogPath)) {
    return fs.readFileSync(f.failedStepLogPath, "utf-8");
  }
  if (f.lastOutputLines && f.lastOutputLines.length > 0) {
    return f.lastOutputLines.join("\n") + "\n";
  }
  return "";
}

function formatFailureHeader(f: JobResult): string {
  if (f.failedStep) {
    return `  ✗ ${f.workflow} > ${f.taskId} > "${f.failedStep}"`;
  }
  return `  ✗ ${f.workflow} > ${f.taskId}`;
}

export function printSummary(results: JobResult[], runDir?: string): void {
  const failures = results.filter((r) => !r.succeeded);
  const passes = results.filter((r) => r.succeeded);
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

  if (failures.length > 0) {
    process.stdout.write("\n━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n");

    // Group failures by error content to avoid repeating identical errors
    const groups: { failures: JobResult[]; errorContent: string }[] = [];
    const seen = new Map<string, (typeof groups)[number]>();

    for (const f of failures) {
      const content = getErrorContent(f);
      const existing = seen.get(content);
      if (existing) {
        existing.failures.push(f);
      } else {
        const group = { failures: [f], errorContent: content };
        groups.push(group);
        seen.set(content, group);
      }
    }

    for (const group of groups) {
      for (const f of group.failures) {
        process.stdout.write(formatFailureHeader(f) + "\n");
      }
      if (group.errorContent) {
        process.stdout.write("\n" + group.errorContent);
      }
      // Emit the hint from the first failure in the group that carries one.
      // Hints are computed per-job when the failure is built, and duplicates
      // within a group would just repeat the same message.
      const hint = group.failures.find((f) => f.hint)?.hint;
      if (hint) {
        process.stdout.write("\n" + hint + "\n");
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
