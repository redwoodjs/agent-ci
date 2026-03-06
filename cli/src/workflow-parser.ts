import fs from "fs";
import path from "path";
import crypto from "crypto";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";

// @actions/workflow-parser imports JSON without `type: json` assertion,
// which fails on Node.js v22+. Lazy-import it only in the two functions
// that actually need it (getWorkflowTemplate, parseWorkflowSteps).
async function loadWorkflowParser() {
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
) {
  const template = await getWorkflowTemplate(filePath);
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));

  // Derive repoPath from filePath (.../repoPath/.github/workflows/foo.yml → repoPath)
  const repoPath = path.dirname(path.dirname(path.dirname(filePath)));
  // Find the job by ID or Name
  const job = template.jobs.find((j) => {
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
      let stepName = step.name
        ? expandExpressions(step.name.toString(), repoPath, secrets, matrixContext)
        : stepId;
      const rawStep = rawSteps[index] || {};

      // Fix for __actions_checkout issue
      // If a step uses an action but has no name, @actions/workflow-parser might auto-generate a name like __actions_checkout
      // which causes the runner to treat it as a special internal step expecting specific inputs.
      // We force a display name if one isn't provided.
      if (!step.name && (step as any).uses) {
        stepName = (step as any).uses.toString();
      }

      if ("run" in step) {
        // Prefer the raw YAML value over step.run.toString(): the workflow-parser
        // stringifies expression trees in ways that can truncate multiline scripts
        // (e.g. dropping the text after an embedded ${{ }} boundary). The raw YAML
        // string is always the complete literal block scalar.
        const rawScript = rawStep.run != null ? String(rawStep.run) : step.run.toString();
        const inputs: Record<string, string> = {
          script: expandExpressions(rawScript, repoPath, secrets, matrixContext),
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
                  expandExpressions(String(v), repoPath, secrets),
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
                    expandExpressions(String(v), repoPath, secrets, matrixContext),
                  ]),
                )
              : {}),
            // Merge from raw YAML (overrides parsed values), expanding expressions
            ...Object.fromEntries(
              Object.entries(stepWith).map(([k, v]) => [
                k,
                expandExpressions(String(v), repoPath, secrets, matrixContext),
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
                      expandExpressions(String(v), repoPath),
                    ]),
                  ),
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
          Env: rawStep.env
            ? Object.fromEntries(
                Object.entries(rawStep.env).map(([k, v]) => [
                  k,
                  expandExpressions(String(v), repoPath, secrets, matrixContext),
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

export function isWorkflowRelevant(template: any, branch: string) {
  const events = template.events;
  if (!events) {
    return false;
  }

  // 1. Check pull_request
  if (events.pull_request) {
    const pr = events.pull_request;
    // If pull_request has branch filters, check if 'main' (target) is included.
    // This simulates a PR being raised against main.
    if (!pr.branches && !pr["branches-ignore"]) {
      return true; // No filters, matches all PRs
    }

    if (pr.branches) {
      if (pr.branches.some((pattern: string) => minimatch("main", pattern))) {
        return true;
      }
    }

    if (pr["branches-ignore"]) {
      if (!pr["branches-ignore"].some((pattern: string) => minimatch("main", pattern))) {
        return true;
      }
    }
  }

  // 2. Check push
  if (events.push) {
    const push = events.push;
    if (!push.branches && !push["branches-ignore"]) {
      return true; // No filters, matches all pushes
    }

    if (push.branches) {
      if (push.branches.some((pattern: string) => minimatch(branch, pattern))) {
        return true;
      }
    }

    if (push["branches-ignore"]) {
      if (!push["branches-ignore"].some((pattern: string) => minimatch(branch, pattern))) {
        return true;
      }
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
    `[Machinen] Missing secrets required by workflow job "${taskName}".\n` +
      `Add the following to ${secretsFilePath}:\n\n` +
      missing.map((n) => `${n}=`).join("\n") +
      "\n",
  );
}
