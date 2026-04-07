/**
 * Core types for the TypeScript GitHub Actions runner.
 */

import type { ExpressionContext } from "./expressions.js";
import type { Annotation } from "./commands.js";

// ---------------------------------------------------------------------------
// Workflow model (parsed from YAML)
// ---------------------------------------------------------------------------

export interface Workflow {
  name: string;
  jobs: Job[];
  env?: Record<string, string>;
}

export interface Job {
  id: string;
  name: string;
  needs: string[];
  if?: string;
  steps: Step[];
  env?: Record<string, string>;
  outputs?: Record<string, string>;
  /** Matrix combinations — each combo becomes a separate job run. */
  matrix?: Record<string, string>[];
  timeoutMinutes?: number;
  continueOnError?: boolean;
}

export type Step = ScriptStep | ActionStep;

interface StepBase {
  id: string;
  name: string;
  if?: string;
  env?: Record<string, string>;
  continueOnError?: boolean;
  timeoutMinutes?: number;
  workingDirectory?: string;
}

export interface ScriptStep extends StepBase {
  type: "script";
  run: string;
  shell?: string;
}

export interface ActionStep extends StepBase {
  type: "action";
  uses: string;
  with?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export type StepOutputs = Record<string, string>;

export interface StepResult {
  id: string;
  name: string;
  /** What actually happened: success, failure, or skipped. */
  outcome: "success" | "failure" | "skipped";
  /** Like outcome, but success if continue-on-error is true and step failed. */
  conclusion: "success" | "failure" | "skipped";
  exitCode?: number;
  outputs: StepOutputs;
  envUpdates: Record<string, string>;
  pathUpdates: string[];
  annotations?: Annotation[];
  durationMs: number;
}

export interface JobResult {
  id: string;
  name: string;
  status: "success" | "failure" | "skipped";
  steps: StepResult[];
  outputs: StepOutputs;
  durationMs: number;
}

export interface WorkflowResult {
  name: string;
  status: "success" | "failure";
  jobs: JobResult[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

export interface RunContext {
  /** Absolute path to the workspace root. */
  workspace: string;
  /** Expression evaluation context — mutated as steps run. */
  expressionCtx: ExpressionContext;
  /** Additional PATH entries from previous steps. */
  extraPath: string[];
  /** Callback for step output lines. */
  onOutput?: (line: string) => void;
}
