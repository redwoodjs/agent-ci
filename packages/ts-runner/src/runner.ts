/**
 * Workflow runner — the top-level orchestrator.
 *
 * Parses a workflow, resolves job dependencies, expands matrices,
 * and runs jobs in dependency order.
 */

import path from "path";

import type { ExpressionContext } from "./expressions.js";
import { evaluateCondition, interpolate } from "./expressions.js";
import { runJob, type JobRunnerOptions } from "./job-runner.js";
import { parseWorkflowFile } from "./workflow-parser.js";
import type { Job, JobResult, WorkflowResult, RunContext } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
  /** Path to the workflow YAML file. */
  workflowPath: string;
  /** Absolute path to the workspace/repo root. */
  workspace: string;
  /** Secrets to inject. */
  secrets?: Record<string, string>;
  /** Extra env vars. */
  env?: Record<string, string>;
  /** Workflow dispatch inputs. */
  inputs?: Record<string, string>;
  /** Callback for step output lines. */
  onOutput?: (line: string) => void;
  /** Callback when a job starts. */
  onJobStart?: (job: { id: string; name: string }) => void;
  /** Callback when a job finishes. */
  onJobEnd?: (result: JobResult) => void;
  /** Callback when a step starts. */
  onStepStart?: (info: { jobId: string; stepId: string; stepName: string; index: number }) => void;
  /** Callback when a step ends. */
  onStepEnd?: (info: {
    jobId: string;
    stepId: string;
    outcome: string;
    durationMs: number;
  }) => void;
}

/**
 * Run an entire workflow file.
 */
export async function runWorkflow(opts: RunWorkflowOptions): Promise<WorkflowResult> {
  const startTime = Date.now();
  const workflow = parseWorkflowFile(opts.workflowPath);

  // Build base expression context
  const baseCtx = buildBaseContext(opts);

  // Apply workflow-level env
  if (workflow.env) {
    baseCtx.env = { ...baseCtx.env, ...workflow.env };
  }

  // Topological sort into execution waves
  const waves = topoSort(workflow.jobs);

  const jobResults: JobResult[] = [];
  const jobOutputs: Record<string, { outputs: Record<string, string>; result: string }> = {};

  for (const wave of waves) {
    // Jobs in the same wave can run in parallel (they don't depend on each other)
    // For now, run sequentially. Parallel execution is a future optimization.
    for (const job of wave) {
      // Expand matrix — each combo is a separate job run
      const matrixCombos = job.matrix ?? [{}];

      for (const matrix of matrixCombos) {
        // Build needs context from completed upstream jobs
        const needs: ExpressionContext["needs"] = {};
        for (const depId of job.needs) {
          if (jobOutputs[depId]) {
            needs[depId] = jobOutputs[depId];
          }
        }

        const jobCtx: ExpressionContext = {
          ...structuredClone(baseCtx),
          matrix,
          needs,
          steps: {},
        };

        // Evaluate job-level `if:`
        if (job.if) {
          const shouldRun = evaluateCondition(job.if, jobCtx);
          if (!shouldRun) {
            const skipped: JobResult = {
              id: job.id,
              name: job.name,
              status: "skipped" as any,
              steps: [],
              outputs: {},
              durationMs: 0,
            };
            jobResults.push(skipped);
            jobOutputs[job.id] = { outputs: {}, result: "skipped" };
            opts.onJobEnd?.(skipped);
            continue;
          }
        }

        // Check that upstream jobs succeeded (unless if: overrides)
        if (!job.if) {
          const upstreamFailed = job.needs.some((depId) => jobOutputs[depId]?.result !== "success");
          if (upstreamFailed) {
            const skipped: JobResult = {
              id: job.id,
              name: job.name,
              status: "skipped" as any,
              steps: [],
              outputs: {},
              durationMs: 0,
            };
            jobResults.push(skipped);
            jobOutputs[job.id] = { outputs: {}, result: "skipped" };
            opts.onJobEnd?.(skipped);
            continue;
          }
        }

        const matrixSuffix =
          Object.keys(matrix).length > 0 ? ` (${Object.values(matrix).join(", ")})` : "";

        opts.onJobStart?.({ id: job.id, name: `${job.name}${matrixSuffix}` });

        const result = await runJob(job, {
          workspace: opts.workspace,
          expressionCtx: jobCtx,
          onOutput: opts.onOutput,
          onStepStart: (s) =>
            opts.onStepStart?.({ jobId: job.id, stepId: s.id, stepName: s.name, index: s.index }),
          onStepEnd: (s) =>
            opts.onStepEnd?.({
              jobId: job.id,
              stepId: s.id,
              outcome: s.outcome,
              durationMs: s.durationMs,
            }),
        });

        jobResults.push(result);
        jobOutputs[job.id] = {
          outputs: result.outputs,
          result: result.status === "success" ? "success" : "failure",
        };

        opts.onJobEnd?.(result);
      }
    }
  }

  const anyFailed = jobResults.some((r) => r.status === "failure");

  return {
    name: workflow.name,
    status: anyFailed ? "failure" : "success",
    jobs: jobResults,
    durationMs: Date.now() - startTime,
  };
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Topologically sort jobs into waves that can execute in parallel.
 *
 * Wave 0: jobs with no dependencies
 * Wave 1: jobs whose dependencies are all in wave 0
 * etc.
 */
function topoSort(jobs: Job[]): Job[][] {
  const jobMap = new Map(jobs.map((j) => [j.id, j]));
  const waves: Job[][] = [];
  const placed = new Set<string>();

  // Safety valve: prevent infinite loops if there are cycles
  let maxIterations = jobs.length;

  while (placed.size < jobs.length && maxIterations-- > 0) {
    const wave: Job[] = [];

    for (const job of jobs) {
      if (placed.has(job.id)) {
        continue;
      }
      const depsReady = job.needs.every((dep) => placed.has(dep));
      if (depsReady) {
        wave.push(job);
      }
    }

    if (wave.length === 0) {
      // Remaining jobs have unresolvable dependencies — add them anyway
      const remaining = jobs.filter((j) => !placed.has(j.id));
      waves.push(remaining);
      break;
    }

    for (const job of wave) {
      placed.add(job.id);
    }
    waves.push(wave);
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

function buildBaseContext(opts: RunWorkflowOptions): ExpressionContext {
  const repoName = path.basename(opts.workspace);

  return {
    github: {
      action: "",
      actor: "local",
      event_name: "push",
      event: {},
      job: "",
      ref: "refs/heads/main",
      ref_name: "main",
      repository: `local/${repoName}`,
      run_id: "1",
      run_number: "1",
      sha: "0000000000000000000000000000000000000000",
      head_sha: "0000000000000000000000000000000000000000",
      head_ref: "main",
      workspace: opts.workspace,
      server_url: "https://github.com",
      api_url: "https://api.github.com",
    },
    env: opts.env ?? {},
    secrets: opts.secrets ?? {},
    matrix: {},
    steps: {},
    needs: {},
    runner: {
      os: "Linux",
      arch: "X64",
      name: "ts-runner",
      temp: "/tmp",
      tool_cache: "/tmp/tool-cache",
    },
    job: {
      status: "success",
    },
    inputs: opts.inputs ?? {},
    workspace: opts.workspace,
  };
}
