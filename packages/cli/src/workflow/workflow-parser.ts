import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";

// @actions/workflow-parser imports .json files without `with { type: "json" }`,
// which Node 22+ rejects. Register a custom ESM loader hook that transparently
// adds the missing attribute before we dynamically import the module.
import { register } from "node:module";

let hookRegistered = false;

async function loadWorkflowParser() {
  if (!hookRegistered) {
    hookRegistered = true;
    try {
      register("../hooks/json-loader.js", import.meta.url);
    } catch {
      // In test environments (Vitest), the hook file may not resolve and
      // Vite already handles JSON imports via its inline config.
    }
  }
  return await import("@actions/workflow-parser");
}

/**
 * Expand `${{ expr }}` placeholders in a string.
 * Handles:
 *  - hashFiles('pattern1', 'pattern2', ...) → sha256 of matching files under repoPath
 *  - runner.os → 'Linux'
 *  - github.run_id → a stable numeric string
 *  - github.sha → '0000000000000000000000000000000000000000'
 *  - (others) → empty string (safe: no commas injected)
 */
export function expandExpressions(
  value: string,
  repoPath?: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
): string {
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
    const trimmed = expr.trim();

    // hashFiles('glob1', 'glob2', ...)
    const hashFilesMatch = trimmed.match(/^hashFiles\(([\s\S]+)\)$/);
    if (hashFilesMatch) {
      if (!repoPath) {
        return "0000000000000000000000000000000000000000";
      }
      try {
        // Parse the argument list: quoted strings separated by commas
        const args = hashFilesMatch[1].match(/['"][^'"]*['"]/g) ?? [];
        const patterns = args.map((a) => a.replace(/^['"]|['"]$/g, ""));
        const hash = crypto.createHash("sha256");
        let hasAny = false;
        for (const pattern of patterns) {
          let files: string[];
          try {
            files = findFiles(repoPath, pattern);
          } catch {
            files = [];
          }
          for (const f of files.sort()) {
            try {
              const content = fs.readFileSync(f);
              hash.update(content);
              hasAny = true;
            } catch {
              // File not readable, skip
            }
          }
        }
        if (!hasAny) {
          return "0000000000000000000000000000000000000000";
        }
        return hash.digest("hex");
      } catch {
        return "0000000000000000000000000000000000000000";
      }
    }

    // fromJSON(expr) — parse JSON from a string (or inner expression)
    const fromJsonMatch = trimmed.match(/^fromJSON\(([\s\S]+)\)$/);
    if (fromJsonMatch) {
      const inner = fromJsonMatch[1].trim();
      // If the inner arg is a quoted string literal, use it directly
      let rawValue: string;
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        rawValue = inner.slice(1, -1);
      } else {
        // Otherwise, treat it as an expression and expand it
        rawValue = expandExpressions(
          `\${{ ${inner} }}`,
          repoPath,
          secrets,
          matrixContext,
          needsContext,
        );
      }
      try {
        const parsed = JSON.parse(rawValue);
        if (typeof parsed === "string") {
          return parsed;
        }
        return JSON.stringify(parsed);
      } catch {
        return "";
      }
    }

    // toJSON(expr) — serialize a value to JSON
    const toJsonMatch = trimmed.match(/^toJSON\(([\s\S]+)\)$/);
    if (toJsonMatch) {
      const inner = toJsonMatch[1].trim();
      let rawValue: string;
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        rawValue = inner.slice(1, -1);
      } else {
        rawValue = expandExpressions(
          `\${{ ${inner} }}`,
          repoPath,
          secrets,
          matrixContext,
          needsContext,
        );
      }
      return JSON.stringify(rawValue);
    }

    // format('template {0} {1}', arg0, arg1)
    const formatMatch = trimmed.match(/^format\(([\s\S]+)\)$/);
    if (formatMatch) {
      const formatArgs = formatMatch[1].match(/(?:['"][^'"]*['"]|[^,]+)/g) ?? [];
      const cleaned = formatArgs.map((a) => a.trim().replace(/^['"]|['"]$/g, ""));
      const template = cleaned[0] || "";
      const args = cleaned.slice(1);
      return template.replace(/\{(\d+)\}/g, (_m, idx) => {
        const i = parseInt(idx, 10);
        if (i < args.length) {
          // Recursively expand the arg value in case it's a context reference
          return expandExpressions(`\${{ ${args[i]} }}`, repoPath);
        }
        return "";
      });
    }

    // Context variable substitutions
    if (trimmed === "runner.os") {
      return "Linux";
    }
    if (trimmed === "runner.arch") {
      return "X64";
    }
    if (trimmed === "github.run_id") {
      return "1";
    }
    if (trimmed === "github.run_number") {
      return "1";
    }
    if (trimmed === "github.sha" || trimmed === "github.head_sha") {
      return "0000000000000000000000000000000000000000";
    }
    if (trimmed === "github.ref_name" || trimmed === "github.head_ref") {
      return "main";
    }
    if (trimmed === "github.repository") {
      return "local/repo";
    }
    if (trimmed === "github.actor") {
      return "local";
    }
    if (trimmed === "github.event.pull_request.number") {
      return "";
    }
    if (trimmed === "github.event.pull_request.title") {
      return "";
    }
    if (trimmed === "github.event.pull_request.user.login") {
      return "";
    }
    if (trimmed === "strategy.job-total") {
      return matrixContext?.["__job_total"] ?? "1";
    }
    if (trimmed === "strategy.job-index") {
      return matrixContext?.["__job_index"] ?? "0";
    }
    if (trimmed.startsWith("matrix.")) {
      const key = trimmed.slice("matrix.".length);
      return matrixContext?.[key] ?? "";
    }
    if (trimmed.startsWith("secrets.")) {
      const name = trimmed.slice("secrets.".length);
      return secrets?.[name] ?? "";
    }
    if (trimmed.startsWith("steps.") && trimmed.endsWith(".outputs.cache-hit")) {
      return "";
    }
    if (trimmed.startsWith("steps.")) {
      return "";
    }
    if (trimmed.startsWith("needs.") && needsContext) {
      // needs.<jobId>.outputs.<name> or needs.<jobId>.result
      const parts = trimmed.split(".");
      const jobId = parts[1];
      const jobOutputs = needsContext[jobId];
      if (parts[2] === "outputs" && parts[3]) {
        return jobOutputs?.[parts[3]] ?? "";
      }
      if (parts[2] === "result") {
        // If the job is in the needsContext, it completed (default to 'success')
        return jobOutputs ? (jobOutputs["__result"] ?? "success") : "";
      }
      return "";
    }
    if (trimmed.startsWith("needs.")) {
      return "";
    }

    // Unknown expressions — return empty string (safe: no commas injected)
    return "";
  });
}

/**
 * Simple recursive file finder using minimatch patterns.
 * Searches under rootDir for files matching pattern.
 */
function findFiles(rootDir: string, pattern: string): string[] {
  const results: string[] = [];
  const normPattern = pattern.replace(/^\.\//, "");

  function walk(dir: string, relative: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const relChild = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), relChild);
      } else if (minimatch(relChild, normPattern, { dot: true })) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir, "");
  return results;
}

export async function getWorkflowTemplate(filePath: string) {
  const { parseWorkflow, NoOperationTraceWriter, convertWorkflowTemplate } =
    await loadWorkflowParser();
  const content = fs.readFileSync(filePath, "utf8");
  const result = parseWorkflow({ name: filePath, content }, new NoOperationTraceWriter());

  if (result.value === undefined) {
    throw new Error(
      `Failed to parse workflow: ${result.context.errors
        .getErrors()
        .map((e: any) => e.message)
        .join(", ")}`,
    );
  }

  return await convertWorkflowTemplate(result.context, result.value);
}

/**
 * Collapse a matrix definition to a single job using the first value of each key.
 * Sets __job_total to "1" and __job_index to "0".
 * Used by the --no-matrix flag to run a matrix workflow as a single container.
 */
export function collapseMatrixToSingle(matrixDef: Record<string, any[]>): Record<string, string>[] {
  const combo: Record<string, string> = {};
  for (const [key, values] of Object.entries(matrixDef)) {
    if (values.length > 0) {
      combo[key] = String(values[0]);
    }
  }
  combo.__job_total = "1";
  combo.__job_index = "0";
  return [combo];
}

/**
 * Compute the Cartesian product of a matrix definition.
 * Values are always coerced to strings.
 * Returns [{}] for an empty matrix so callers always get at least one combination.
 */
export function expandMatrixCombinations(
  matrixDef: Record<string, any[]>,
): Record<string, string>[] {
  const keys = Object.keys(matrixDef);
  if (keys.length === 0) {
    return [{}];
  }
  let combos: Record<string, string>[] = [{}];
  for (const key of keys) {
    const values = matrixDef[key];
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const val of values) {
        next.push({ ...combo, [key]: String(val) });
      }
    }
    combos = next;
  }
  return combos;
}

/**
 * Read the `strategy.matrix` object for a given job from the raw YAML.
 * Returns null if the job has no matrix.
 */
export async function parseMatrixDef(
  filePath: string,
  jobId: string,
): Promise<Record<string, any[]> | null> {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const matrix = yaml?.jobs?.[jobId]?.strategy?.matrix;
  if (!matrix || typeof matrix !== "object") {
    return null;
  }
  // Only keep keys whose values are arrays
  const result: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(matrix)) {
    if (Array.isArray(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function parseWorkflowSteps(
  filePath: string,
  taskName: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
) {
  const template = await getWorkflowTemplate(filePath);
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));

  // Derive repoPath from filePath (.../repoPath/.github/workflows/foo.yml → repoPath)
  const repoPath = path.dirname(path.dirname(path.dirname(filePath)));
  // Find the job by ID or Name
  const job = (template.jobs ?? []).find((j) => {
    if (j.type !== "job") {
      return false;
    }
    return j.id.toString() === taskName || (j.name && j.name.toString() === taskName);
  });

  if (!job || job.type !== "job") {
    throw new Error(`Task "${taskName}" not found in workflow "${filePath}"`);
  }

  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawSteps = rawJob.steps || [];

  return job.steps
    .map((step, index) => {
      const stepId = step.id || `step-${index + 1}`;
      const rawStep = rawSteps[index] || {};
      // Prefer raw YAML name to preserve ${{ }} expressions for our own expansion
      const rawName = rawStep.name != null ? String(rawStep.name) : step.name?.toString();
      let stepName = rawName
        ? expandExpressions(rawName, repoPath, secrets, matrixContext, needsContext)
        : stepId;

      // If a step lacks an explicit name, we map it to standard GitHub Actions defaults
      if (!step.name) {
        if ("run" in step) {
          const runText = rawStep.run != null ? String(rawStep.run) : step.run.toString();
          // Extract the first non-empty line of the script
          const firstLine =
            runText
              .split("\n")
              .map((l: string) => l.trim())
              .find(Boolean) || "command";
          stepName = `Run ${firstLine}`;
        } else if ((step as any).uses) {
          stepName = `Run ${(step as any).uses.toString()}`;
        }
      }

      if ("run" in step) {
        // Prefer the raw YAML value over step.run.toString(): the workflow-parser
        // stringifies expression trees in ways that can truncate multiline scripts
        // (e.g. dropping the text after an embedded ${{ }} boundary). The raw YAML
        // string is always the complete literal block scalar.
        const rawScript = rawStep.run != null ? String(rawStep.run) : step.run.toString();
        const inputs: Record<string, string> = {
          script: expandExpressions(rawScript, repoPath, secrets, matrixContext, needsContext),
        };
        if (rawStep["working-directory"]) {
          inputs.workingDirectory = rawStep["working-directory"];
        }
        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          Reference: {
            Type: "Script",
          },
          Inputs: inputs,
          Env: rawStep.env
            ? Object.fromEntries(
                Object.entries(rawStep.env).map(([k, v]) => [
                  k,
                  expandExpressions(String(v), repoPath, secrets, undefined, needsContext),
                ]),
              )
            : undefined,
        };
      } else if ("uses" in step) {
        // Basic support for 'uses' steps
        // Parse uses string: owner/repo@ref
        const uses = step.uses.toString();
        let name = uses;
        let ref = "";

        if (uses.indexOf("@") >= 0) {
          const parts = uses.split("@");
          name = parts[0];
          ref = parts[1];
        }

        const isCheckout = name.trim().toLowerCase() === "actions/checkout";
        const stepWith = rawStep.with || {};

        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          Reference: {
            Type: "Repository",
            Name: name,
            Ref: ref,
            RepositoryType: "GitHub",
            Path: "",
          },
          Inputs: {
            // with: values from @actions/workflow-parser are expression objects; call toString() on each.
            ...((step as any).with
              ? Object.fromEntries(
                  Object.entries((step as any).with).map(([k, v]) => [
                    k,
                    expandExpressions(String(v), repoPath, secrets, matrixContext, needsContext),
                  ]),
                )
              : {}),
            // Merge from raw YAML (overrides parsed values), expanding expressions
            ...Object.fromEntries(
              Object.entries(stepWith).map(([k, v]) => [
                k,
                expandExpressions(String(v), repoPath, secrets, matrixContext, needsContext),
              ]),
            ),
            ...(isCheckout
              ? {
                  clean: "false",
                  "fetch-depth": "0",
                  lfs: "false",
                  submodules: "false",
                  ...Object.fromEntries(
                    Object.entries(stepWith).map(([k, v]) => [
                      k,
                      expandExpressions(String(v), repoPath, secrets, undefined, needsContext),
                    ]),
                  ),
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
          Env: rawStep.env
            ? Object.fromEntries(
                Object.entries(rawStep.env).map(([k, v]) => [
                  k,
                  expandExpressions(String(v), repoPath, secrets, matrixContext, needsContext),
                ]),
              )
            : undefined,
        };
      }
      return null;
    })
    .filter(Boolean);
}

export interface WorkflowService {
  name: string;
  image: string;
  env?: Record<string, string>;
  ports?: string[];
  options?: string;
}

export async function parseWorkflowServices(
  filePath: string,
  taskName: string,
): Promise<WorkflowService[]> {
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawServices = rawJob.services;
  if (!rawServices || typeof rawServices !== "object") {
    return [];
  }

  return Object.entries(rawServices).map(([name, def]: [string, any]) => {
    const svc: WorkflowService = {
      name,
      image: def.image || "",
    };
    if (def.env && typeof def.env === "object") {
      svc.env = Object.fromEntries(Object.entries(def.env).map(([k, v]) => [k, String(v)]));
    }
    if (Array.isArray(def.ports)) {
      svc.ports = def.ports.map(String);
    }
    if (def.options) {
      svc.options = String(def.options);
    }
    return svc;
  });
}

export interface WorkflowContainer {
  image: string;
  env?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  options?: string;
}

/**
 * Parse the `container:` directive from a workflow job.
 * Returns null if the job doesn't specify a container.
 *
 * Supports both short form (`container: node:18`) and
 * long form (`container: { image: ..., env: ..., ... }`).
 */
export async function parseWorkflowContainer(
  filePath: string,
  taskName: string,
): Promise<WorkflowContainer | null> {
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawJob = rawYaml.jobs?.[taskName] || {};
  const rawContainer = rawJob.container;
  if (!rawContainer) {
    return null;
  }

  // Short form: `container: node:18`
  if (typeof rawContainer === "string") {
    return { image: rawContainer };
  }

  if (typeof rawContainer !== "object") {
    return null;
  }

  const result: WorkflowContainer = {
    image: rawContainer.image || "",
  };
  if (!result.image) {
    return null;
  }
  if (rawContainer.env && typeof rawContainer.env === "object") {
    result.env = Object.fromEntries(
      Object.entries(rawContainer.env).map(([k, v]) => [k, String(v)]),
    );
  }
  if (Array.isArray(rawContainer.ports)) {
    result.ports = rawContainer.ports.map(String);
  }
  if (Array.isArray(rawContainer.volumes)) {
    result.volumes = rawContainer.volumes.map(String);
  }
  if (rawContainer.options) {
    result.options = String(rawContainer.options);
  }
  return result;
}

/**
 * Get the list of files changed in the current commit relative to the previous
 * commit. Returns an empty array on error (safe fallback: all workflows run).
 */
export function getChangedFiles(repoRoot: string): string[] {
  try {
    const output = execSync("git diff --name-only HEAD~1", {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .trim()
      .split("\n")
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Check whether the changed files pass the paths / paths-ignore filter for an
 * event definition. Returns true (relevant) when:
 *  - No changedFiles provided or the array is empty (safe fallback).
 *  - No paths / paths-ignore filters are defined.
 *  - At least one changed file matches a `paths` pattern.
 *  - At least one changed file is NOT matched by all `paths-ignore` patterns.
 */
function matchesPaths(eventDef: Record<string, any>, changedFiles?: string[]): boolean {
  if (!changedFiles || changedFiles.length === 0) {
    return true; // No file info → always relevant
  }

  const pathsFilter: string[] | undefined = eventDef.paths;
  const pathsIgnore: string[] | undefined = eventDef["paths-ignore"];

  if (!pathsFilter && !pathsIgnore) {
    return true; // No path filters defined
  }

  if (pathsFilter) {
    // At least one changed file must match one of the path patterns
    return changedFiles.some((file) => pathsFilter.some((pattern) => minimatch(file, pattern)));
  }

  if (pathsIgnore) {
    // At least one changed file must NOT be matched by all ignore patterns
    return changedFiles.some((file) => !pathsIgnore.some((pattern) => minimatch(file, pattern)));
  }

  return true;
}

export function isWorkflowRelevant(template: any, branch: string, changedFiles?: string[]) {
  const events = template.events;
  if (!events) {
    return false;
  }

  // 1. Check pull_request
  if (events.pull_request) {
    const pr = events.pull_request;
    // If pull_request has branch filters, check if 'main' (target) is included.
    // This simulates a PR being raised against main.
    let branchMatches = false;
    if (!pr.branches && !pr["branches-ignore"]) {
      branchMatches = true; // No filters, matches all PRs
    } else if (pr.branches) {
      branchMatches = pr.branches.some((pattern: string) => minimatch("main", pattern));
    } else if (pr["branches-ignore"]) {
      branchMatches = !pr["branches-ignore"].some((pattern: string) => minimatch("main", pattern));
    }

    if (branchMatches && matchesPaths(pr, changedFiles)) {
      return true;
    }
  }

  // 2. Check pull_request_target (same logic as pull_request)
  if (events.pull_request_target) {
    const prt = events.pull_request_target;
    let branchMatches = false;
    if (!prt.branches && !prt["branches-ignore"]) {
      branchMatches = true;
    } else if (prt.branches) {
      branchMatches = prt.branches.some((pattern: string) => minimatch("main", pattern));
    } else if (prt["branches-ignore"]) {
      branchMatches = !prt["branches-ignore"].some((pattern: string) => minimatch("main", pattern));
    }

    if (branchMatches && matchesPaths(prt, changedFiles)) {
      return true;
    }
  }

  // 3. Check push
  if (events.push) {
    const push = events.push;
    let branchMatches = false;
    if (!push.branches && !push["branches-ignore"]) {
      branchMatches = true; // No filters, matches all pushes
    } else if (push.branches) {
      branchMatches = push.branches.some((pattern: string) => minimatch(branch, pattern));
    } else if (push["branches-ignore"]) {
      branchMatches = !push["branches-ignore"].some((pattern: string) =>
        minimatch(branch, pattern),
      );
    }

    if (branchMatches && matchesPaths(push, changedFiles)) {
      return true;
    }
  }

  return false;
}

/**
 * Scan a workflow file for all `${{ secrets.FOO }}` references.
 * If `taskName` is provided, only the YAML subtree for that job is scanned.
 * Returns a sorted, de-duplicated list of secret names.
 */
export function extractSecretRefs(filePath: string, taskName?: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  // Scope to the job subtree when a taskName is given so we don't pick up
  // secrets from other jobs.
  let source = raw;
  if (taskName) {
    try {
      const parsed = parseYaml(raw);
      const jobDef = parsed?.jobs?.[taskName];
      if (jobDef) {
        source = JSON.stringify(jobDef);
      }
    } catch {
      // Fall back to scanning the whole file
    }
  }
  const names = new Set<string>();
  for (const m of source.matchAll(/\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

/**
 * Validate that all secrets referenced in a workflow job are present in the
 * provided secrets map. Throws with a descriptive message listing the missing
 * secret names and the expected file path if any are absent.
 */
export function validateSecrets(
  filePath: string,
  taskName: string,
  secrets: Record<string, string>,
  secretsFilePath: string,
): void {
  const required = extractSecretRefs(filePath, taskName);
  const missing = required.filter((name) => !secrets[name]);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `[Agent CI] Missing secrets required by workflow job "${taskName}".\n` +
      `Add the following to ${secretsFilePath}:\n\n` +
      missing.map((n) => `${n}=`).join("\n") +
      "\n",
  );
}

/**
 * Parse `jobs.<id>.outputs` definitions from a workflow YAML file.
 * Returns a Record<outputName, expressionTemplate> (e.g. { skip: "${{ steps.check.outputs.skip }}" }).
 * Returns {} if the job has no outputs or doesn't exist.
 */
export function parseJobOutputDefs(filePath: string, jobId: string): Record<string, string> {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const outputs = yaml?.jobs?.[jobId]?.outputs;
  if (!outputs || typeof outputs !== "object") {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) {
    result[k] = String(v);
  }
  return result;
}

/**
 * Parse the `if:` condition from a workflow job.
 * Returns the raw expression string (with `${{ }}` wrapper stripped if present),
 * or null if the job has no `if:`.
 */
export function parseJobIf(filePath: string, jobId: string): string | null {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const rawIf = yaml?.jobs?.[jobId]?.if;
  if (rawIf == null) {
    return null;
  }
  let expr = String(rawIf).trim();
  // Strip ${{ }} wrapper if present
  const wrapped = expr.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) {
    expr = wrapped[1];
  }
  return expr;
}

/**
 * Evaluate a job-level `if:` condition.
 *
 * @param expr       The expression string (already stripped of `${{ }}`)
 * @param jobResults Record<jobId, "success" | "failure"> for upstream jobs
 * @param needsCtx   Optional needs output context (same shape as expandExpressions needsContext)
 * @returns          Whether the job should run
 */
export function evaluateJobIf(
  expr: string,
  jobResults: Record<string, string>,
  needsCtx?: Record<string, Record<string, string>>,
): boolean {
  const trimmed = expr.trim();

  // Empty expression defaults to success()
  if (!trimmed) {
    return evaluateAtom("success()", jobResults, needsCtx);
  }

  // Handle || (split first — lower precedence)
  if (trimmed.includes("||")) {
    const parts = splitOnOperator(trimmed, "||");
    if (parts.length > 1) {
      return parts.some((p) => evaluateJobIf(p.trim(), jobResults, needsCtx));
    }
  }

  // Handle &&
  if (trimmed.includes("&&")) {
    const parts = splitOnOperator(trimmed, "&&");
    if (parts.length > 1) {
      return parts.every((p) => evaluateJobIf(p.trim(), jobResults, needsCtx));
    }
  }

  return evaluateAtom(trimmed, jobResults, needsCtx);
}

/**
 * Split an expression on a logical operator, respecting parentheses and quotes.
 */
function splitOnOperator(expr: string, op: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote: string | null = null;
  let current = "";

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    }
    if (ch === ")") {
      depth--;
    }
    if (depth === 0 && expr.slice(i, i + op.length) === op) {
      parts.push(current);
      current = "";
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/**
 * Evaluate a single atomic condition (no && or ||).
 */
function evaluateAtom(
  expr: string,
  jobResults: Record<string, string>,
  needsCtx?: Record<string, Record<string, string>>,
): boolean {
  const trimmed = expr.trim();

  // Status check functions
  if (trimmed === "always()") {
    return true;
  }
  if (trimmed === "cancelled()") {
    return false;
  }
  if (trimmed === "success()") {
    return Object.values(jobResults).every((r) => r === "success");
  }
  if (trimmed === "failure()") {
    return Object.values(jobResults).some((r) => r === "failure");
  }

  // != comparison
  const neqMatch = trimmed.match(/^(.+?)\s*!=\s*(.+)$/);
  if (neqMatch) {
    const left = resolveValue(neqMatch[1].trim(), needsCtx);
    const right = resolveValue(neqMatch[2].trim(), needsCtx);
    return left !== right;
  }

  // == comparison
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*(.+)$/);
  if (eqMatch) {
    const left = resolveValue(eqMatch[1].trim(), needsCtx);
    const right = resolveValue(eqMatch[2].trim(), needsCtx);
    return left === right;
  }

  // Bare truthy value (e.g. needs.setup.outputs.run_tests)
  const val = resolveValue(trimmed, needsCtx);
  return val !== "" && val !== "false" && val !== "0";
}

/**
 * Resolve a value reference in a condition expression.
 */
function resolveValue(raw: string, needsCtx?: Record<string, Record<string, string>>): string {
  const trimmed = raw.trim();
  // Quoted string literal
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  // needs.<jobId>.outputs.<name>
  if (trimmed.startsWith("needs.") && needsCtx) {
    const parts = trimmed.split(".");
    const jobId = parts[1];
    const jobOutputs = needsCtx[jobId];
    if (parts[2] === "outputs" && parts[3]) {
      return jobOutputs?.[parts[3]] ?? "";
    }
    if (parts[2] === "result") {
      return jobOutputs ? (jobOutputs["__result"] ?? "success") : "";
    }
  }
  return trimmed;
}

/**
 * Parse `strategy.fail-fast` for a job.
 * Returns true/false if explicitly set, undefined if not specified.
 */
export function parseFailFast(filePath: string, jobId: string): boolean | undefined {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const strategy = yaml?.jobs?.[jobId]?.strategy;
  if (!strategy || typeof strategy !== "object") {
    return undefined;
  }
  if ("fail-fast" in strategy) {
    return Boolean(strategy["fail-fast"]);
  }
  return undefined;
}
