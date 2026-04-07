/**
 * ts-runner — TypeScript replacement for the GitHub Actions runner.
 *
 * Public API: import { runWorkflow } from "@redwoodjs/ts-runner"
 */

export { runWorkflow, type RunWorkflowOptions } from "./runner.js";
export { runJob, type JobRunnerOptions } from "./job-runner.js";
export { executeStep } from "./step-executor.js";
export { parseWorkflowFile, parseWorkflowYaml } from "./workflow-parser.js";
export {
  evaluate,
  interpolate,
  evaluateCondition,
  type ExpressionContext,
  type ExpressionValue,
} from "./expressions.js";
export type {
  Workflow,
  Job,
  Step,
  StepResult,
  JobResult,
  WorkflowResult,
  RunContext,
} from "./types.js";
