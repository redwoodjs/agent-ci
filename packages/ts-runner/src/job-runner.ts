/**
 * Job runner — executes all steps in a job sequentially.
 *
 * Manages the step lifecycle:
 * 1. Evaluate step `if:` condition
 * 2. Run the step
 * 3. Capture outputs, env updates, path additions
 * 4. Update the expression context for subsequent steps
 */

import type { ExpressionContext } from "./expressions.js";
import { executeStep } from "./step-executor.js";
import type { Job, JobResult, StepResult, RunContext } from "./types.js";

export interface JobRunnerOptions {
  /** Absolute path to the workspace root. */
  workspace: string;
  /** Base expression context (github, env, secrets, etc). */
  expressionCtx: ExpressionContext;
  /** Callback for each output line from steps. */
  onOutput?: (line: string) => void;
  /** Callback fired when a step starts. */
  onStepStart?: (step: { id: string; name: string; index: number }) => void;
  /** Callback fired when a step finishes. */
  onStepEnd?: (result: StepResult & { index: number }) => void;
}

/**
 * Run all steps in a job.
 *
 * Steps run sequentially. Each step's outputs and env mutations
 * are folded into the context for subsequent steps.
 */
export async function runJob(job: Job, opts: JobRunnerOptions): Promise<JobResult> {
  const startTime = Date.now();
  const stepResults: StepResult[] = [];

  // Clone expression context so mutations don't leak to caller
  const ctx: RunContext = {
    workspace: opts.workspace,
    expressionCtx: cloneContext(opts.expressionCtx),
    extraPath: [],
    onOutput: opts.onOutput,
  };

  // Apply job-level env
  if (job.env) {
    ctx.expressionCtx.env = { ...ctx.expressionCtx.env, ...job.env };
  }

  let jobFailed = false;

  for (let i = 0; i < job.steps.length; i++) {
    const step = job.steps[i];

    opts.onStepStart?.({ id: step.id, name: step.name, index: i });

    const result = await executeStep(step, ctx);
    stepResults.push(result);

    opts.onStepEnd?.({ ...result, index: i });

    // Update expression context with step results
    ctx.expressionCtx.steps[step.id] = {
      outputs: result.outputs,
      outcome: result.outcome,
      conclusion: result.conclusion,
    };

    // Apply env updates from this step to subsequent steps
    if (Object.keys(result.envUpdates).length > 0) {
      ctx.expressionCtx.env = { ...ctx.expressionCtx.env, ...result.envUpdates };
    }

    // Apply PATH updates
    if (result.pathUpdates.length > 0) {
      ctx.extraPath = [...result.pathUpdates, ...ctx.extraPath];
    }

    // Check for failure
    if (result.conclusion === "failure") {
      jobFailed = true;
      // Don't stop — remaining steps might have `if: failure()` or `if: always()`
      // But we do need to update the default condition check
    }
  }

  // Resolve job outputs from output definitions
  const jobOutputs: Record<string, string> = {};
  if (job.outputs) {
    const { interpolate } = await import("./expressions.js");
    for (const [name, template] of Object.entries(job.outputs)) {
      jobOutputs[name] = interpolate(template, ctx.expressionCtx);
    }
  }

  return {
    id: job.id,
    name: job.name,
    status: jobFailed ? "failure" : "success",
    steps: stepResults,
    outputs: jobOutputs,
    durationMs: Date.now() - startTime,
  };
}

function cloneContext(ctx: ExpressionContext): ExpressionContext {
  return {
    github: { ...ctx.github },
    env: { ...ctx.env },
    secrets: { ...ctx.secrets },
    matrix: { ...ctx.matrix },
    steps: {},
    needs: { ...ctx.needs },
    runner: { ...ctx.runner },
    job: { ...ctx.job },
    inputs: { ...ctx.inputs },
    workspace: ctx.workspace,
  };
}
