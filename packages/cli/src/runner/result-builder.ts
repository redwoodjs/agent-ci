import path from "path";
import fs from "fs";
import { type JobResult, type StepResult, tailLogFile } from "../output/reporter.js";

// ─── Timeline parsing ─────────────────────────────────────────────────────────

/**
 * Read `timeline.json` and map task records into `StepResult[]`.
 */
export function parseTimelineSteps(timelinePath: string): StepResult[] {
  try {
    if (!fs.existsSync(timelinePath)) {
      return [];
    }
    const records: any[] = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    return records
      .filter((r: any) => r.type === "Task" && r.name)
      .map((r: any) => ({
        name: r.name,
        status:
          r.result === "Succeeded" || r.result === "succeeded"
            ? ("passed" as const)
            : r.result === "Failed" || r.result === "failed"
              ? ("failed" as const)
              : r.result === "Skipped" || r.result === "skipped"
                ? ("skipped" as const)
                : r.state === "completed"
                  ? ("passed" as const)
                  : ("skipped" as const),
      }));
  } catch {
    return [];
  }
}

// ─── Step name sanitization ───────────────────────────────────────────────────

/**
 * Reproduce the DTU sanitization logic for step log filenames.
 */
export function sanitizeStepName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 80);
}

// ─── Failure details extraction ───────────────────────────────────────────────

export interface FailureDetails {
  exitCode?: number;
  stepLogPath?: string;
  tailLines?: string[];
}

/**
 * Given a failed step name and the timeline, extract:
 *  - The actual exit code (from the issues array)
 *  - The path to the step's log file
 *  - The last N lines of that log
 */
export function extractFailureDetails(
  timelinePath: string,
  failedStepName: string,
  logDir: string,
): FailureDetails {
  const result: FailureDetails = {};
  try {
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    const failedRecord = timeline.find((r: any) => r.name === failedStepName && r.type === "Task");
    if (!failedRecord) {
      return result;
    }

    // Attempt to parse the actual step exit code from the issues array
    const issueMsg = failedRecord.issues?.find((i: any) => i.type === "error")?.message;
    if (issueMsg) {
      const m = issueMsg.match(/exit code (\d+)/i);
      if (m) {
        result.exitCode = parseInt(m[1], 10);
      }
    }

    const stepsDir = path.join(logDir, "steps");
    const sanitized = sanitizeStepName(failedStepName);

    // Try sanitized name first, then record.id (feed handler), then log.id (POST/PUT handlers)
    for (const id of [sanitized, failedRecord.id, failedRecord.log?.id]) {
      if (!id) {
        continue;
      }
      const stepLogPath = path.join(stepsDir, `${id}.log`);
      if (fs.existsSync(stepLogPath)) {
        result.stepLogPath = stepLogPath;
        result.tailLines = tailLogFile(stepLogPath);
        break;
      }
    }
  } catch {
    /* best-effort */
  }
  return result;
}

// ─── Job result builder ───────────────────────────────────────────────────────

export interface BuildJobResultOpts {
  containerName: string;
  job: { workflowPath?: string; taskId?: string };
  startTime: number;
  jobSucceeded: boolean;
  lastFailedStep: string | null;
  containerExitCode: number;
  timelinePath: string;
  logDir: string;
  debugLogPath: string;
}

/**
 * Build the structured `JobResult` from container exit state and timeline data.
 */
export function buildJobResult(opts: BuildJobResultOpts): JobResult {
  const {
    containerName,
    job,
    startTime,
    jobSucceeded,
    lastFailedStep,
    containerExitCode,
    timelinePath,
    logDir,
    debugLogPath,
  } = opts;

  const steps = parseTimelineSteps(timelinePath);
  const result: JobResult = {
    name: containerName,
    workflow: job.workflowPath ? path.basename(job.workflowPath) : "unknown",
    taskId: job.taskId ?? "unknown",
    succeeded: jobSucceeded,
    durationMs: Date.now() - startTime,
    debugLogPath,
    steps,
  };

  if (!jobSucceeded) {
    result.failedStep = lastFailedStep ?? undefined;
    // The container exits with 0 if it successfully reported the job failure,
    // so only use the container exit code if it actually indicates a crash (non-zero).
    result.failedExitCode = containerExitCode !== 0 ? containerExitCode : undefined;

    if (lastFailedStep) {
      const failure = extractFailureDetails(timelinePath, lastFailedStep, logDir);
      if (failure.exitCode !== undefined) {
        result.failedExitCode = failure.exitCode;
      }
      result.failedStepLogPath = failure.stepLogPath;
      result.lastOutputLines = failure.tailLines ?? [];
    } else {
      result.lastOutputLines = [];
    }
  }

  return result;
}
