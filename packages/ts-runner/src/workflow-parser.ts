/**
 * Workflow YAML parser.
 *
 * Reads a GitHub Actions workflow file and produces the internal
 * Workflow/Job/Step model used by the runner.
 */

import fs from "fs";
import { parse as parseYaml } from "yaml";

import type { Workflow, Job, Step, ScriptStep, ActionStep } from "./types.js";

/**
 * Parse a workflow YAML file into the runner's internal model.
 */
export function parseWorkflowFile(filePath: string): Workflow {
  const content = fs.readFileSync(filePath, "utf8");
  return parseWorkflowYaml(content, filePath);
}

/**
 * Parse workflow YAML content.
 */
export function parseWorkflowYaml(content: string, sourcePath?: string): Workflow {
  const yaml = parseYaml(content);

  if (!yaml || typeof yaml !== "object") {
    throw new Error(`Invalid workflow YAML${sourcePath ? ` in ${sourcePath}` : ""}`);
  }

  const rawJobs = yaml.jobs;
  if (!rawJobs || typeof rawJobs !== "object") {
    throw new Error(`No jobs defined${sourcePath ? ` in ${sourcePath}` : ""}`);
  }

  const jobs: Job[] = [];

  for (const [jobId, rawJob] of Object.entries(rawJobs) as [string, any][]) {
    jobs.push(parseJob(jobId, rawJob));
  }

  return {
    name: yaml.name ?? sourcePath ?? "workflow",
    on: parseTriggers(yaml.on),
    jobs,
    env: yaml.env ? normalizeEnv(yaml.env) : undefined,
  };
}

/**
 * Extract trigger event names from the `on:` key.
 */
function parseTriggers(raw: unknown): string[] {
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.map(String);
  }
  if (raw && typeof raw === "object") {
    return Object.keys(raw);
  }
  return ["push"];
}

function parseJob(id: string, raw: any): Job {
  const steps = (raw.steps ?? []).map((s: any, i: number) => parseStep(s, i));
  const needs = Array.isArray(raw.needs) ? raw.needs : raw.needs ? [raw.needs] : [];

  const job: Job = {
    id,
    name: raw.name ?? id,
    needs,
    steps,
    env: raw.env ? normalizeEnv(raw.env) : undefined,
  };

  if (raw.if != null) {
    job.if = String(raw.if);
  }

  if (raw.outputs) {
    job.outputs = normalizeStringRecord(raw.outputs);
  }

  if (raw.strategy?.matrix) {
    job.matrix = expandMatrix(raw.strategy.matrix);
  }

  if (raw["timeout-minutes"] != null) {
    job.timeoutMinutes = Number(raw["timeout-minutes"]);
  }

  if (raw["continue-on-error"] != null) {
    job.continueOnError = Boolean(raw["continue-on-error"]);
  }

  return job;
}

function parseStep(raw: any, index: number): Step {
  const id = raw.id ?? `step-${index + 1}`;
  const base = {
    id,
    env: raw.env ? normalizeEnv(raw.env) : undefined,
    if: raw.if != null ? String(raw.if) : undefined,
    continueOnError:
      raw["continue-on-error"] != null ? Boolean(raw["continue-on-error"]) : undefined,
    timeoutMinutes: raw["timeout-minutes"] != null ? Number(raw["timeout-minutes"]) : undefined,
    workingDirectory: raw["working-directory"] ?? undefined,
  };

  if (raw.run != null) {
    const name = raw.name ?? `Run ${firstLine(String(raw.run))}`;
    const step: ScriptStep = {
      ...base,
      type: "script",
      name,
      run: String(raw.run),
      shell: raw.shell ?? undefined,
    };
    return step;
  }

  if (raw.uses != null) {
    const uses = String(raw.uses);
    const name = raw.name ?? `Run ${uses}`;
    const step: ActionStep = {
      ...base,
      type: "action",
      name,
      uses,
      with: raw.with ? normalizeStringRecord(raw.with) : undefined,
    };
    return step;
  }

  throw new Error(`Step ${index + 1} has neither 'run' nor 'uses'`);
}

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

/**
 * Expand a matrix definition into all combinations.
 *
 * Handles:
 * - Simple key: [value1, value2] mappings
 * - `include:` additional combinations
 * - `exclude:` filtered combinations
 */
function expandMatrix(raw: any): Record<string, string>[] {
  const include = raw.include ?? [];
  const exclude = raw.exclude ?? [];

  // Gather the key-value arrays (exclude special keys)
  const axes: Record<string, any[]> = {};
  for (const [key, values] of Object.entries(raw)) {
    if (key === "include" || key === "exclude") {
      continue;
    }
    if (Array.isArray(values)) {
      axes[key] = values;
    }
  }

  // Compute cartesian product
  let combos = cartesian(axes);

  // Apply excludes
  if (exclude.length > 0) {
    combos = combos.filter((combo) => {
      return !exclude.some((ex: any) => matchesCombo(combo, ex));
    });
  }

  // Apply includes (add extra combos, or merge into matching ones)
  for (const inc of include) {
    const match = combos.find((c) => matchesCombo(c, inc));
    if (match) {
      // Merge extra keys into existing combo
      for (const [k, v] of Object.entries(inc)) {
        match[k] = String(v);
      }
    } else {
      // Add as a new combo
      combos.push(normalizeStringRecord(inc));
    }
  }

  return combos.length > 0 ? combos : [{}];
}

function cartesian(axes: Record<string, any[]>): Record<string, string>[] {
  const keys = Object.keys(axes);
  if (keys.length === 0) {
    return [{}];
  }

  let result: Record<string, string>[] = [{}];
  for (const key of keys) {
    const next: Record<string, string>[] = [];
    for (const combo of result) {
      for (const val of axes[key]) {
        next.push({ ...combo, [key]: String(val) });
      }
    }
    result = next;
  }
  return result;
}

function matchesCombo(combo: Record<string, string>, pattern: Record<string, any>): boolean {
  return Object.entries(pattern).every(([k, v]) => combo[k] === String(v));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEnv(raw: Record<string, any>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

function normalizeStringRecord(raw: Record<string, any>): Record<string, string> {
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
}

function firstLine(s: string): string {
  const line = s
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return line ?? "command";
}
