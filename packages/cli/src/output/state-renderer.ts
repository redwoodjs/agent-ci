// ─── State Renderer ───────────────────────────────────────────────────────────
// Pure function: RunState → string.
// The render loop in cli.ts calls this on every tick and passes the result to
// logUpdate. No side effects, no I/O — fully testable in isolation.

import path from "path";
import { renderTree, type TreeNode } from "./tree-renderer.js";
import type { RunState, JobState, StepState } from "./run-state.js";

// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const YELLOW = `${String.fromCharCode(27)}[33m`;
const DIM = `${String.fromCharCode(27)}[2m`;
const RESET = `${String.fromCharCode(27)}[0m`;

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getSpinnerFrame(): string {
  return SPINNER_FRAMES[Math.floor(Date.now() / 80) % SPINNER_FRAMES.length];
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

// ─── Step node builder ────────────────────────────────────────────────────────

function buildStepNode(step: StepState, job: JobState, padW: number): TreeNode {
  const pad = (n: number) => String(n).padStart(padW);
  const dur = step.durationMs !== undefined ? ` (${Math.round(step.durationMs / 1000)}s)` : "";

  switch (step.status) {
    case "running": {
      const elapsed = step.startedAt
        ? Math.round((Date.now() - new Date(step.startedAt).getTime()) / 1000)
        : 0;
      const frame = getSpinnerFrame();
      // Retrying (was paused, now running again on same step)
      if ((job.attempt ?? 0) > 0 && job.pausedAtStep === step.name) {
        return { label: `${frame} ${pad(step.index)}. ${step.name} — retrying (${elapsed}s...)` };
      }
      return { label: `${frame} ${pad(step.index)}. ${step.name} (${elapsed}s...)` };
    }

    case "paused": {
      const frozenElapsed =
        job.pausedAtMs && step.startedAt
          ? Math.round(
              (new Date(job.pausedAtMs).getTime() - new Date(step.startedAt).getTime()) / 1000,
            )
          : step.startedAt
            ? Math.round((Date.now() - new Date(step.startedAt).getTime()) / 1000)
            : 0;
      return {
        label: `⏸ ${pad(step.index)}. ${step.name} (${frozenElapsed}s)`,
        children: [{ label: `${YELLOW}Step failed attempt #${job.attempt ?? 1}${RESET}` }],
      };
    }

    case "failed":
      return { label: `✗ ${pad(step.index)}. ${step.name}${dur}` };

    case "skipped":
      return { label: `⊘ ${pad(step.index)}. ${step.name}${dur}` };

    case "completed":
      return { label: `✓ ${pad(step.index)}. ${step.name}${dur}` };

    case "pending":
    default:
      return { label: `○ ${pad(step.index)}. ${step.name}` };
  }
}

// ─── Job node builder ─────────────────────────────────────────────────────────

/**
 * Build the TreeNode(s) for a job.
 *
 * - `singleJobMode`: true when there is exactly one job across all workflows.
 *   In this mode the "Starting runner" node is shown alongside the job node,
 *   matching the pre-refactor single-workflow rendering.
 */
function buildJobNodes(job: JobState, singleJobMode: boolean): TreeNode[] {
  // ── Booting (container starting, no timeline yet) ──────────────────────────
  if (job.status === "booting") {
    const elapsed = job.startedAt
      ? Math.round((Date.now() - new Date(job.startedAt).getTime()) / 1000)
      : 0;
    const bootNode: TreeNode = {
      label: `${getSpinnerFrame()} Starting runner ${job.runnerId} (${elapsed}s)`,
    };
    const children: TreeNode[] = [];
    if (job.pullProgress) {
      const { currentBytes, totalBytes } = job.pullProgress;
      const pct = totalBytes > 0 ? Math.round((currentBytes / totalBytes) * 100) : 0;
      children.push({
        label: `${DIM}Pulling image: ${fmtBytes(currentBytes)} / ${fmtBytes(totalBytes)} (${pct}%)${RESET}`,
      });
    }
    if (job.logDir) {
      children.push({ label: `${DIM}Logs: ${job.logDir}${RESET}` });
    }
    if (children.length > 0) {
      bootNode.children = children;
    }
    return [bootNode];
  }

  // ── Completed / failed in multi-job mode → collapse to one line ────────────
  if (!singleJobMode && (job.status === "completed" || job.status === "failed")) {
    const icon = job.failedStep ? "✗" : "✓";
    const dur = job.durationMs !== undefined ? ` (${Math.round(job.durationMs / 1000)}s)` : "";
    return [{ label: `${icon} ${job.id} ${DIM}${job.runnerId}${RESET}${dur}` }];
  }

  // ── Build step nodes ───────────────────────────────────────────────────────
  const padW = String(job.steps.length).length;
  const stepNodes = job.steps.map((step) => buildStepNode(step, job, padW));

  // Retry hint in multi-job paused mode (shown as a child node)
  if (!singleJobMode && job.status === "paused" && job.pausedAtStep) {
    stepNodes.push({
      label: `${YELLOW}↻ retry: agent-ci retry --runner ${job.runnerId}${RESET}`,
    });
  }

  // ── Single-job mode: show "Starting runner" alongside job node ─────────────
  if (singleJobMode) {
    const bootLabel =
      job.bootDurationMs !== undefined
        ? `Starting runner ${job.runnerId} (${fmtMs(job.bootDurationMs)})`
        : `Starting runner ${job.runnerId}`;
    const bootNode: TreeNode = { label: bootLabel };
    if (job.logDir) {
      bootNode.children = [{ label: `${DIM}Logs: ${job.logDir}${RESET}` }];
    }
    return [bootNode, { label: job.id, children: stepNodes }];
  }

  // ── Multi-job mode: show job name with steps as children ──────────────────
  return [{ label: `${job.id} ${DIM}${job.runnerId}${RESET}`, children: stepNodes }];
}

// ─── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render the full run state into a string for display via logUpdate.
 *
 * This is a pure function: given the same RunState and the same wall-clock time
 * it always produces the same output. Spinner frames are derived from Date.now().
 */
export function renderRunState(state: RunState): string {
  const totalJobs = state.workflows.reduce((sum, wf) => sum + wf.jobs.length, 0);
  const singleJobMode = state.workflows.length === 1 && totalJobs === 1;

  const roots: TreeNode[] = [];
  let pausedSingleJob: JobState | undefined;

  for (const wf of state.workflows) {
    const children: TreeNode[] = [];
    for (const job of wf.jobs) {
      children.push(...buildJobNodes(job, singleJobMode));

      // Capture the first paused job for single-job trailing output
      if (singleJobMode && job.status === "paused" && !pausedSingleJob) {
        pausedSingleJob = job;
      }
    }
    roots.push({ label: path.basename(wf.path), children });
  }

  let output = renderTree(roots);

  // ── Single-job pause: append last output + retry/abort hints below tree ────
  if (pausedSingleJob) {
    const { lastOutputLines, runnerId } = pausedSingleJob;
    if (lastOutputLines && lastOutputLines.length > 0) {
      output += `\n\n  ${DIM}Last output:${RESET}`;
      for (const line of lastOutputLines) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          output += `\n    ${DIM}${trimmed}${RESET}`;
        }
      }
    }
    output += `\n\n  ${YELLOW}↻ To retry:  agent-ci retry --runner ${runnerId} [enter]${RESET}`;
    output += `\n  ${YELLOW}■ To abort:  agent-ci abort --runner ${runnerId}${RESET}`;
  }

  return output;
}
