import path from "path";
import fs from "fs";
import { type JobResult, type StepResult, tailLogFile } from "../output/reporter.js";
import {
  detectMissingToolHint,
  detectToolcacheHint,
  type ResolvedRunnerImage,
} from "./runner-image.js";

// ─── Timeline parsing ─────────────────────────────────────────────────────────

/**
 * Read `timeline.json` and map task records into `StepResult[]`.
 *
 * When `logDir` is provided, attach `logPath` to each step by locating the
 * step's log under `<logDir>/steps/`. The DTU keys per-step log files by one
 * of: sanitized step name, record id, or log id — we try all three and use
 * the first that exists on disk. Passing-run log directories get cleaned up
 * after the run, so `logPath` is only set when the file is present.
 */
export function parseTimelineSteps(timelinePath: string, logDir?: string): StepResult[] {
  try {
    if (!fs.existsSync(timelinePath)) {
      return [];
    }
    const records: any[] = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
    const stepsDir = logDir ? path.join(logDir, "steps") : null;
    return records
      .filter((r: any) => r.type === "Task" && r.name)
      .map((r: any) => {
        const step: StepResult = {
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
        };
        if (stepsDir) {
          for (const id of [sanitizeStepName(r.name), r.id, r.log?.id]) {
            if (!id) {
              continue;
            }
            const candidate = path.join(stepsDir, `${id}.log`);
            if (fs.existsSync(candidate)) {
              step.logPath = candidate;
              break;
            }
          }
        }
        return step;
      });
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

// ─── Step output extraction ───────────────────────────────────────────────────

/**
 * Extract step outputs from the runner's `_runner_file_commands/` directory.
 *
 * The GitHub Actions runner writes step outputs to files named `set_output_<uuid>`
 * in `<workDir>/_runner_file_commands/`. Each file contains key=value pairs,
 * with multiline values using the heredoc format:
 *   key<<DELIMITER
 *   line1
 *   line2
 *   DELIMITER
 *
 * @param workDir The container's work directory (bind-mounted from host)
 * @returns Record<string, string> of all output key-value pairs
 */
export function extractStepOutputs(workDir: string): Record<string, string> {
  const outputs: Record<string, string> = {};

  // The runner writes to _temp/_runner_file_commands/ under the work dir
  // $GITHUB_OUTPUT = /home/runner/_work/_temp/_runner_file_commands/set_output_<uuid>
  const candidates = [
    path.join(workDir, "_temp", "_runner_file_commands"),
    path.join(workDir, "_runner_file_commands"),
  ];

  for (const fileCommandsDir of candidates) {
    if (!fs.existsSync(fileCommandsDir)) {
      continue;
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(fileCommandsDir).sort(); // Sort for deterministic override order
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.startsWith("set_output_")) {
        continue;
      }

      try {
        const content = fs.readFileSync(path.join(fileCommandsDir, entry), "utf-8");
        parseOutputFileContent(content, outputs);
      } catch {
        // Best-effort: skip unreadable files
      }
    }
  }

  return outputs;
}

/**
 * Parse the content of a single set_output file into the outputs record.
 * Handles both `key=value` and `key<<DELIMITER\nvalue\nDELIMITER` formats.
 */
function parseOutputFileContent(content: string, outputs: Record<string, string>): void {
  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heredoc format: key<<DELIMITER
    const heredocMatch = line.match(/^([^=]+)<<(.+)$/);
    if (heredocMatch) {
      const key = heredocMatch[1];
      const delimiter = heredocMatch[2];
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delimiter) {
        valueLines.push(lines[i]);
        i++;
      }
      outputs[key] = valueLines.join("\n");
      i++; // Skip the closing delimiter
      continue;
    }

    // Simple format: key=value
    const eqIdx = line.indexOf("=");
    if (eqIdx > 0) {
      const key = line.slice(0, eqIdx);
      const value = line.slice(eqIdx + 1);
      outputs[key] = value;
    }

    i++;
  }
}

// ─── Job output resolution ────────────────────────────────────────────────────

/**
 * Resolve job output definitions against actual step outputs.
 *
 * Job output templates reference `steps.<stepId>.outputs.<name>`. Since the
 * runner writes all step outputs to `$GITHUB_OUTPUT` files keyed only by
 * output name (not step ID), we resolve by matching the output name from
 * the template against the flat step outputs map.
 *
 * @param outputDefs  Job output definitions from parseJobOutputDefs
 * @param stepOutputs Flat step outputs from extractStepOutputs
 * @returns Resolved job outputs
 */
export function resolveJobOutputs(
  outputDefs: Record<string, string>,
  stepOutputs: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [outputName, template] of Object.entries(outputDefs)) {
    // Replace ${{ steps.<id>.outputs.<name> }} with the actual step output value
    result[outputName] = template.replace(
      /\$\{\{\s*steps\.[^.]+\.outputs\.([^\s}]+)\s*\}\}/g,
      (_match, outputKey: string) => {
        return stepOutputs[outputKey] ?? "";
      },
    );
  }

  return result;
}

// ─── Job success determination ────────────────────────────────────────────────

/**
 * Determine whether a job succeeded based on container exit state and
 * whether the runner ever contacted the DTU.
 *
 * `isBooting` stays `true` when the runner never sent any timeline entries —
 * it started but couldn't reach the DTU or crashed before executing any steps.
 * That must be treated as a failure regardless of exit code.
 */
export function isJobSuccessful(opts: {
  lastFailedStep: string | null;
  containerExitCode: number;
  isBooting: boolean;
}): boolean {
  return opts.lastFailedStep === null && opts.containerExitCode === 0 && !opts.isBooting;
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
  /** Raw step outputs from $GITHUB_OUTPUT files */
  stepOutputs?: Record<string, string>;
  /** The runner image the job used — used to attach actionable failure hints */
  resolvedRunnerImage?: ResolvedRunnerImage;
  /** Host path of the toolcache bind mount — used for the toolcache-cleanup hint */
  toolCacheDir?: string;
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
    stepOutputs,
  } = opts;

  const steps = parseTimelineSteps(timelinePath, logDir);
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
      // Boot failure — no timeline, so fall back to debug.log for error context
      result.lastOutputLines = tailLogFile(debugLogPath);
    }

    // Attach an actionable hint if the failure matches a known pattern —
    // missing system tool on the default image, or a stale toolcache from a
    // previous run blocking tar extraction.
    const errorContent =
      (result.failedStepLogPath &&
        (() => {
          try {
            return fs.readFileSync(result.failedStepLogPath, "utf-8");
          } catch {
            return "";
          }
        })()) ||
      result.lastOutputLines?.join("\n") ||
      "";
    const missingToolHint = opts.resolvedRunnerImage
      ? detectMissingToolHint(errorContent, opts.resolvedRunnerImage)
      : null;
    const toolcacheHint = detectToolcacheHint(errorContent, opts.toolCacheDir);
    const hint = missingToolHint ?? toolcacheHint;
    if (hint) {
      result.hint = hint;
    }
  }

  // Attach raw step outputs (will be resolved to job outputs by cli.ts)
  if (stepOutputs && Object.keys(stepOutputs).length > 0) {
    result.outputs = stepOutputs;
  }

  return result;
}
