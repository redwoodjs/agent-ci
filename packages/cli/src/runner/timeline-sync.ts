// Timeline polling — substrate-agnostic.
//
// The DTU server writes `timeline.json` (and `outputs.json`) to a host
// directory as the GHA runner makes progress. Both the docker runtime
// and the machinen runtime poll those files from the host side; the
// only thing the substrate (container vs VM) affects is *who* the
// runner is talking to, not the on-disk shape of the timeline.
//
// This module is extracted from local-job.ts so machinen-job.ts can
// reuse the same fold-and-publish logic without duplicating ~200 lines
// of timeline-record handling.

import fs from "node:fs";
import path from "node:path";

import { debugBoot } from "../output/debug.ts";
import { tailLogFile } from "../output/reporter.ts";
import { RunStateStore, type StepState } from "../output/run-state.ts";

/**
 * Mutable state tracked across timeline-poll ticks. The store-sync helper
 * mutates the fields in place; the polling loop and the rest of the
 * runtime's execute function read them once the loop finishes.
 */
export interface TimelineSyncState {
  lastSeenAttempt: number;
  isPaused: boolean;
  pausedAtMs: number | null;
  pausedStepName: string | null;
  isBooting: boolean;
  lastFailedStep: string | null;
}

/** Read-only inputs the store-sync helper needs but does not mutate. */
export interface TimelineSyncContext {
  pauseOnFailure: boolean;
  pausedSignalPath: string;
  signalsDir: string;
  timelinePath: string;
  bootStart: number;
  containerName: string;
  store: RunStateStore | undefined;
  /** Called the first time a pause is detected — sets up the Enter-to-retry stdin listener. */
  onNewPause: () => void;
}

/** Result of folding the timeline-records list into a render-ready shape. */
interface BuiltSteps {
  newSteps: StepState[];
  totalDurationMs: number | undefined;
  jobFinished: boolean;
}

/**
 * Fold the raw actions-runner timeline records into the `StepState[]` shape
 * the renderer expects. Mutates `state.lastFailedStep` when a step result is
 * "failed". Skips duplicate names; the second occurrence (e.g. for a "Post"
 * step) triggers a synthetic "Post Setup" row at the end.
 */
function buildStepsFromTimeline(steps: any[], state: TimelineSyncState): BuiltSteps {
  const seenNames = new Set<string>();
  let hasPostSteps = false;
  let completeJobRecord: any = null;

  const preCountNames = new Set<string>();
  for (const r of steps) {
    if (!preCountNames.has(r.name)) {
      preCountNames.add(r.name);
    } else {
      hasPostSteps = true;
    }
  }

  let stepIdx = 0;
  const newSteps: StepState[] = [];

  for (const r of steps) {
    if (seenNames.has(r.name)) {
      continue;
    }
    seenNames.add(r.name);

    if (r.name === "Complete job") {
      completeJobRecord = r;
      continue;
    }
    stepIdx++;

    const durationMs =
      r.startTime && r.finishTime
        ? new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()
        : undefined;

    let status: StepState["status"];
    if (!r.result && r.state !== "completed") {
      if (r.startTime) {
        status = state.isPaused && state.pausedStepName === r.name ? "paused" : "running";
      } else {
        status = "pending";
      }
    } else {
      const result = (r.result || "").toLowerCase();
      if (result === "failed") {
        state.lastFailedStep = r.name;
        status = "failed";
      } else if (result === "skipped") {
        status = "skipped";
      } else {
        status = "completed";
      }
    }

    newSteps.push({
      name: r.name,
      index: stepIdx,
      status,
      startedAt: r.startTime,
      completedAt: r.finishTime,
      durationMs,
    });
  }

  const jobFinished = !!completeJobRecord?.result;

  if (hasPostSteps && jobFinished) {
    stepIdx++;
    newSteps.push({ name: "Post Setup", index: stepIdx, status: "completed" });
  }

  if (completeJobRecord && jobFinished) {
    stepIdx++;
    const durationMs =
      completeJobRecord.startTime && completeJobRecord.finishTime
        ? new Date(completeJobRecord.finishTime).getTime() -
          new Date(completeJobRecord.startTime).getTime()
        : undefined;
    newSteps.push({
      name: "Complete job",
      index: stepIdx,
      status: "completed",
      startedAt: completeJobRecord.startTime,
      completedAt: completeJobRecord.finishTime,
      durationMs,
    });
  }

  let totalDurationMs: number | undefined;
  if (jobFinished) {
    const allTimes = steps
      .filter((r) => r.startTime && r.finishTime)
      .map((r) => ({
        start: new Date(r.startTime).getTime(),
        end: new Date(r.finishTime).getTime(),
      }));
    if (allTimes.length > 0) {
      const earliest = Math.min(...allTimes.map((t) => t.start));
      const latest = Math.max(...allTimes.map((t) => t.end));
      const ms = latest - earliest;
      if (!Number.isNaN(ms) && ms >= 0) {
        totalDurationMs = ms;
      }
    }
  }

  return { newSteps, totalDurationMs, jobFinished };
}

/**
 * One poll tick of the actions-runner timeline.json into the RunStateStore.
 * Reads the paused-signal file (if `pauseOnFailure` is set) and the timeline
 * JSON; updates the store and the mutable `state` in place. Errors are
 * swallowed — this is best-effort and runs every 100ms.
 */
export function syncTimelineToStore(state: TimelineSyncState, ctx: TimelineSyncContext): void {
  try {
    if (ctx.pauseOnFailure && fs.existsSync(ctx.pausedSignalPath)) {
      const content = fs.readFileSync(ctx.pausedSignalPath, "utf8").trim();
      const lines = content.split("\n");
      state.pausedStepName = lines[0] || null;
      const attempt = Number.parseInt(lines[1] || "1", 10);
      const isNewAttempt = attempt !== state.lastSeenAttempt;
      if (isNewAttempt) {
        state.lastSeenAttempt = attempt;
        state.isPaused = true;
        state.pausedAtMs = Date.now();
        ctx.onNewPause();
      }

      const tailLines = tailLogFile(path.join(ctx.signalsDir, "step-output"), 20);

      ctx.store?.updateJob(ctx.containerName, {
        status: "paused",
        pausedAtStep: state.pausedStepName || undefined,
        ...(isNewAttempt && state.pausedAtMs !== null
          ? { pausedAtMs: new Date(state.pausedAtMs).toISOString(), attempt: state.lastSeenAttempt }
          : {}),
        lastOutputLines: tailLines,
      });
    } else if (state.isPaused && !fs.existsSync(ctx.pausedSignalPath)) {
      state.isPaused = false;
      state.pausedAtMs = null;
      ctx.store?.updateJob(ctx.containerName, { status: "running", pausedAtMs: undefined });
    }

    if (!fs.existsSync(ctx.timelinePath)) {
      return;
    }

    const records = JSON.parse(fs.readFileSync(ctx.timelinePath, "utf8")) as any[];
    const steps = records
      .filter((r) => r.type === "Task" && r.name)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    if (steps.length === 0) {
      return;
    }

    if (state.isBooting) {
      state.isBooting = false;
      debugBoot(`${ctx.containerName} total: ${Date.now() - ctx.bootStart}ms`);
      ctx.store?.updateJob(ctx.containerName, {
        status: state.isPaused ? "paused" : "running",
        bootDurationMs: Date.now() - ctx.bootStart,
      });
    }

    const { newSteps, totalDurationMs, jobFinished } = buildStepsFromTimeline(steps, state);

    ctx.store?.updateJob(ctx.containerName, {
      steps: newSteps,
      ...(jobFinished
        ? {
            status: state.lastFailedStep ? "failed" : "completed",
            failedStep: state.lastFailedStep || undefined,
            durationMs: totalDurationMs,
          }
        : {}),
    });
  } catch {
    // Best-effort.
  }
}
