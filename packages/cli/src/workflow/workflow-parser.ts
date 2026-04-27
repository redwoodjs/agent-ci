import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import { classifyRunsOn } from "../runner/runs-on-compat.js";

/**
 * Values used to resolve `${{ runner.os }}` / `${{ runner.arch }}` at
 * expression-expansion time. GitHub Actions evaluates these per-job based on
 * the job's `runs-on:` label. Prior to issue #279 we hardcoded Linux/X64,
 * which broke scripts gated on `runner.os == 'macOS'` in tart-backed VM jobs.
 */
export type RunnerContext = {
  os: string;
  arch: string;
};

/**
 * Derive a `RunnerContext` from a job's `runs-on:` labels. Defaults to
 * Linux/X64 for unknown labels so existing self-hosted configurations keep
 * working. macOS is mapped to ARM64 because agent-ci's macOS backend (tart)
 * only runs Apple Silicon VMs.
 */
export function runnerContextFromRunsOn(labels: string[]): RunnerContext {
  switch (classifyRunsOn(labels)) {
    case "macos":
      return { os: "macOS", arch: "ARM64" };
    case "windows":
      return { os: "Windows", arch: "X64" };
    default:
      return { os: "Linux", arch: "X64" };
  }
}

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
 * Check if a string value is truthy following GitHub Actions semantics.
 * Falsy values: empty string, "false", "0".
 */
function isExprTruthy(val: string): boolean {
  return val !== "" && val !== "false" && val !== "0";
}

/**
 * Split a function's argument list on commas, respecting quotes and nested parens.
 */
function splitFunctionArgs(argsStr: string): string[] {
  const result: string[] = [];
  let current = "";
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];
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
    if (ch === "," && depth === 0) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  result.push(current.trim());
  return result;
}

/** Strip surrounding quotes from a string if present. */
function unquote(s: string): string {
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Compare two string values using the given operator. */
function compareValues(left: string, right: string, op: string): boolean {
  // GitHub Actions coerces both sides to numbers when possible: empty string,
  // null (surfaced here as ""), and numeric strings all become valid numeric
  // operands. A genuinely non-numeric string coerces to NaN and comparisons
  // involving NaN are all false, so bothNumeric stays false for those.
  const ln = Number(left);
  const rn = Number(right);
  const bothNumeric = !isNaN(ln) && !isNaN(rn);

  switch (op) {
    case "==":
      return bothNumeric ? ln === rn : left.toLowerCase() === right.toLowerCase();
    case "!=":
      return bothNumeric ? ln !== rn : left.toLowerCase() !== right.toLowerCase();
    case "<":
      return bothNumeric ? ln < rn : left.toLowerCase() < right.toLowerCase();
    case ">":
      return bothNumeric ? ln > rn : left.toLowerCase() > right.toLowerCase();
    case "<=":
      return bothNumeric ? ln <= rn : left.toLowerCase() <= right.toLowerCase();
    case ">=":
      return bothNumeric ? ln >= rn : left.toLowerCase() >= right.toLowerCase();
    default:
      return false;
  }
}

/**
 * Resolve a single atomic expression (function call or context variable).
 * Does not handle boolean operators, parentheses, or string literals.
 */
function resolveExprAtom(
  trimmed: string,
  repoPath?: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
  runnerContext?: RunnerContext,
): string {
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
    let rawValue: string;
    if (
      (inner.startsWith("'") && inner.endsWith("'")) ||
      (inner.startsWith('"') && inner.endsWith('"'))
    ) {
      rawValue = inner.slice(1, -1);
    } else {
      rawValue = evaluateExprValue(
        inner,
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
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

  // toJSON(expr) — serialize a value to JSON with 2-space indentation,
  // matching GitHub Actions' pretty-printing behavior. Parse rawValue first
  // so that toJSON(fromJSON(...)) round-trips with pretty-printing instead
  // of re-quoting a compact-JSON string.
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
      rawValue = evaluateExprValue(
        inner,
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
    }
    try {
      return JSON.stringify(JSON.parse(rawValue), null, 2);
    } catch {
      return JSON.stringify(rawValue, null, 2);
    }
  }

  // format('template {0} {1}', arg0, arg1)
  const formatMatch = trimmed.match(/^format\(([\s\S]+)\)$/);
  if (formatMatch) {
    const formatArgs = splitFunctionArgs(formatMatch[1]);
    const template = unquote(formatArgs[0] || "");
    const args = formatArgs.slice(1);
    return template.replace(/\{(\d+)\}/g, (_m, idx) => {
      const i = parseInt(idx, 10);
      if (i < args.length) {
        return evaluateExprValue(
          args[i],
          repoPath,
          secrets,
          matrixContext,
          needsContext,
          inputsContext,
          vars,
          runnerContext,
        );
      }
      return "";
    });
  }

  // contains(search, item) — case-insensitive string search or array inclusion
  const containsMatch = trimmed.match(/^contains\(([\s\S]+)\)$/);
  if (containsMatch) {
    const args = splitFunctionArgs(containsMatch[1]);
    if (args.length >= 2) {
      const haystack = evaluateExprValue(
        args[0],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      const needle = evaluateExprValue(
        args[1],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      // Try JSON array first
      try {
        const arr = JSON.parse(haystack);
        if (Array.isArray(arr)) {
          return arr.some((item) => String(item).toLowerCase() === needle.toLowerCase())
            ? "true"
            : "false";
        }
      } catch {
        // Not JSON — fall through to string search
      }
      return haystack.toLowerCase().includes(needle.toLowerCase()) ? "true" : "false";
    }
    return "false";
  }

  // startsWith(searchString, searchValue)
  const startsWithMatch = trimmed.match(/^startsWith\(([\s\S]+)\)$/);
  if (startsWithMatch) {
    const args = splitFunctionArgs(startsWithMatch[1]);
    if (args.length >= 2) {
      const str = evaluateExprValue(
        args[0],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      const prefix = evaluateExprValue(
        args[1],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      return str.toLowerCase().startsWith(prefix.toLowerCase()) ? "true" : "false";
    }
    return "false";
  }

  // endsWith(searchString, searchValue)
  const endsWithMatch = trimmed.match(/^endsWith\(([\s\S]+)\)$/);
  if (endsWithMatch) {
    const args = splitFunctionArgs(endsWithMatch[1]);
    if (args.length >= 2) {
      const str = evaluateExprValue(
        args[0],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      const suffix = evaluateExprValue(
        args[1],
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      return str.toLowerCase().endsWith(suffix.toLowerCase()) ? "true" : "false";
    }
    return "false";
  }

  // join(array, separator) or join(string, separator)
  const joinMatch = trimmed.match(/^join\(([\s\S]+)\)$/);
  if (joinMatch) {
    const args = splitFunctionArgs(joinMatch[1]);
    const val = evaluateExprValue(
      args[0],
      repoPath,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
      runnerContext,
    );
    const sep =
      args.length >= 2
        ? evaluateExprValue(
            args[1],
            repoPath,
            secrets,
            matrixContext,
            needsContext,
            inputsContext,
            vars,
            runnerContext,
          )
        : ", ";
    try {
      const arr = JSON.parse(val);
      if (Array.isArray(arr)) {
        return arr.map(String).join(sep);
      }
    } catch {
      // Not an array — return as-is
    }
    return val;
  }

  // Status functions — in expression context these return their string name
  if (trimmed === "success()") {
    return "true";
  }
  if (trimmed === "failure()") {
    return "false";
  }
  if (trimmed === "always()") {
    return "true";
  }
  if (trimmed === "cancelled()") {
    return "false";
  }

  // Context variable substitutions
  if (trimmed === "runner.os") {
    return runnerContext?.os ?? "Linux";
  }
  if (trimmed === "runner.arch") {
    return runnerContext?.arch ?? "X64";
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
  if (trimmed.startsWith("vars.")) {
    const name = trimmed.slice("vars.".length);
    return vars?.[name] ?? "";
  }
  if (trimmed.startsWith("inputs.")) {
    const name = trimmed.slice("inputs.".length);
    return inputsContext?.[name] ?? "";
  }
  if (trimmed.startsWith("steps.")) {
    // Step-output references can't be resolved at parse time — the producing
    // step hasn't run yet — and the runner does not re-evaluate `${{ }}`
    // inside run-script bodies at runtime. Returning the sentinel used to
    // leak the literal `${{ }}` to bash and trigger "bad substitution".
    // Per the compatibility contract, resolve to an empty string at parse time.
    return "";
  }
  if (trimmed.startsWith("needs.") && needsContext) {
    const parts = trimmed.split(".");
    const jobId = parts[1];
    const jobOutputs = needsContext[jobId];
    if (parts[2] === "outputs" && parts[3]) {
      return jobOutputs?.[parts[3]] ?? "";
    }
    if (parts[2] === "result") {
      return jobOutputs ? (jobOutputs["__result"] ?? "success") : "";
    }
    return "";
  }
  if (trimmed.startsWith("needs.")) {
    return "";
  }

  // Unknown atoms — return empty string
  return "";
}

/**
 * Evaluate an expression that may contain ||, &&, !, parentheses,
 * string literals, function calls, and context variable references.
 * Returns the string result following GitHub Actions expression semantics.
 */
function evaluateExprValue(
  expr: string,
  repoPath?: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
  runnerContext?: RunnerContext,
): string {
  const trimmed = expr.trim();
  if (!trimmed) {
    return "";
  }

  // Strip matching outer parentheses
  if (trimmed.startsWith("(")) {
    let depth = 0;
    let inQuote: string | null = null;
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        }
        continue;
      }
      if (ch === "'" || ch === '"') {
        inQuote = ch;
        continue;
      }
      if (ch === "(") {
        depth++;
      }
      if (ch === ")") {
        depth--;
      }
      if (depth === 0 && i === trimmed.length - 1) {
        return evaluateExprValue(
          trimmed.slice(1, -1),
          repoPath,
          secrets,
          matrixContext,
          needsContext,
          inputsContext,
          vars,
          runnerContext,
        );
      }
      if (depth === 0) {
        break;
      }
    }
  }

  // Handle || (lowest precedence)
  const orParts = splitOnOperator(trimmed, "||");
  if (orParts.length > 1) {
    let lastVal = "";
    for (const part of orParts) {
      lastVal = evaluateExprValue(
        part.trim(),
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      if (isExprTruthy(lastVal)) {
        return lastVal;
      }
    }
    return lastVal;
  }

  // Handle && (higher precedence than ||)
  const andParts = splitOnOperator(trimmed, "&&");
  if (andParts.length > 1) {
    let lastVal = "";
    for (const part of andParts) {
      lastVal = evaluateExprValue(
        part.trim(),
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      if (!isExprTruthy(lastVal)) {
        return lastVal;
      }
    }
    return lastVal;
  }

  // Handle comparison operators (==, !=, <=, >=, <, >)
  // Check longer operators first to avoid matching <= as < then =
  for (const op of ["!=", "==", "<=", ">=", "<", ">"]) {
    const cmpParts = splitOnOperator(trimmed, op);
    if (cmpParts.length === 2) {
      const left = evaluateExprValue(
        cmpParts[0].trim(),
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      const right = evaluateExprValue(
        cmpParts[1].trim(),
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      );
      const result = compareValues(left, right, op);
      return result ? "true" : "false";
    }
  }

  // Handle ! prefix (negation)
  if (trimmed.startsWith("!")) {
    const inner = evaluateExprValue(
      trimmed.slice(1).trim(),
      repoPath,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
      runnerContext,
    );
    return isExprTruthy(inner) ? "false" : "true";
  }

  // String literal
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }

  // Boolean / null literals
  if (trimmed === "true") {
    return "true";
  }
  if (trimmed === "false") {
    return "false";
  }
  if (trimmed === "null") {
    return "";
  }

  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed;
  }

  // Atom: function call or context variable
  return resolveExprAtom(
    trimmed,
    repoPath,
    secrets,
    matrixContext,
    needsContext,
    inputsContext,
    vars,
    runnerContext,
  );
}

/**
 * Expand `${{ expr }}` placeholders in a string.
 * Handles boolean operators (&&, ||, !), parentheses, string literals,
 * built-in functions (hashFiles, fromJSON, toJSON, format), and context
 * variable references (runner.*, github.*, matrix.*, secrets.*, etc.).
 */
export function expandExpressions(
  value: string,
  repoPath?: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
  runnerContext?: RunnerContext,
): string {
  return value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
    const result = evaluateExprValue(
      expr,
      repoPath,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
      runnerContext,
    );
    return result;
  });
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
}

export function parseJobRunsOnLabels(filePath: string, jobId: string): string[] {
  try {
    const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
    const rawRunsOn = rawYaml?.jobs?.[jobId]?.["runs-on"];

    if (typeof rawRunsOn === "string") {
      return [rawRunsOn];
    }

    if (Array.isArray(rawRunsOn)) {
      return rawRunsOn.map(String);
    }

    if (rawRunsOn == null) {
      return [];
    }

    return [String(rawRunsOn)];
  } catch {
    return [];
  }
}

export function parseMergedJobEnv(
  filePath: string,
  jobId: string,
  matrixContext?: Record<string, string>,
): Record<string, string> {
  try {
    const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));
    const workflowEnv = toStringRecord(rawYaml?.env);
    const jobEnv = toStringRecord(rawYaml?.jobs?.[jobId]?.env);
    const merged = { ...workflowEnv, ...jobEnv };

    if (!matrixContext) {
      return merged;
    }

    return Object.fromEntries(
      Object.entries(merged).map(([key, value]) => [
        key,
        expandExpressions(value, undefined, undefined, matrixContext),
      ]),
    );
  } catch {
    return {};
  }
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
      // Skip node_modules only. Dotted directories (`.github`, `.cargo`, …)
      // are common hashFiles targets and GitHub Actions' hashFiles descends
      // into them when the pattern asks for them.
      if (entry.name === "node_modules") {
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

/**
 * Shells we wrap scripts for, by invoking them as a child process via heredoc.
 * The runner always executes Script steps with bash; when the user asks for a
 * non-bash shell we need to hand the script off to the requested interpreter
 * ourselves. Flags mirror what the GitHub-hosted runner uses by default.
 */
const SHELL_INVOCATIONS: Record<string, string> = {
  sh: "sh -e",
  python: "python3",
  pwsh: "pwsh -NoLogo -NoProfile -NonInteractive -Command -",
};

function wrapScriptForShell(script: string, shell: string): string {
  const invocation = SHELL_INVOCATIONS[shell];
  if (!invocation) {
    // bash, or something we don't know how to wrap — leave the script alone.
    // The runner's default shell is bash, which is what most workflows expect.
    return script;
  }
  // Use a delimiter that is extremely unlikely to appear in real scripts.
  const delimiter = "__AGENT_CI_SHELL_WRAP_EOF__";
  return `${invocation} <<'${delimiter}'\n${script}\n${delimiter}`;
}

/**
 * Resolve a `defaults.run.<key>` value with GitHub Actions precedence:
 * step override beats job `defaults.run.<key>`, which beats workflow-level
 * `defaults.run.<key>`. Returns undefined when none is declared at any level.
 */
function resolveStepRunDefault(
  rawYaml: unknown,
  rawJob: unknown,
  rawStep: unknown,
  key: string,
): string | undefined {
  const pick = (source: unknown): string | undefined => {
    if (!source || typeof source !== "object") {
      return undefined;
    }
    const v = (source as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const pickDefault = (source: unknown): string | undefined => {
    if (!source || typeof source !== "object") {
      return undefined;
    }
    const run = (source as { defaults?: { run?: unknown } }).defaults?.run;
    return pick(run);
  };
  return pick(rawStep) ?? pickDefault(rawJob) ?? pickDefault(rawYaml);
}

/**
 * Build a step's effective env by merging workflow-level, job-level, and
 * step-level `env:` blocks in that order — step overrides job overrides
 * workflow, per GitHub Actions semantics — then expanding each value's
 * `${{ }}` expressions.
 *
 * Returns undefined when no env is declared at any level, matching the
 * prior shape so a step with no env produces no `Env` field.
 */
function buildStepEnv(
  rawYaml: unknown,
  rawJob: unknown,
  rawStep: unknown,
  repoPath: string | undefined,
  secrets: Record<string, string> | undefined,
  matrixContext: Record<string, string> | undefined,
  needsContext: Record<string, Record<string, string>> | undefined,
  inputsContext: Record<string, string> | undefined,
  vars: Record<string, string> | undefined,
  runnerContext: RunnerContext | undefined,
): Record<string, string> | undefined {
  const pick = (source: unknown): Record<string, unknown> => {
    if (!source || typeof source !== "object") {
      return {};
    }
    const env = (source as { env?: unknown }).env;
    return env && typeof env === "object" ? (env as Record<string, unknown>) : {};
  };
  const merged: Record<string, unknown> = {
    ...pick(rawYaml),
    ...pick(rawJob),
    ...pick(rawStep),
  };
  if (Object.keys(merged).length === 0) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [
      k,
      expandExpressions(
        String(v),
        repoPath,
        secrets,
        matrixContext,
        needsContext,
        inputsContext,
        vars,
        runnerContext,
      ),
    ]),
  );
}

export async function parseWorkflowSteps(
  filePath: string,
  taskName: string,
  secrets?: Record<string, string>,
  matrixContext?: Record<string, string>,
  needsContext?: Record<string, Record<string, string>>,
  inputsContext?: Record<string, string>,
  vars?: Record<string, string>,
) {
  const template = await getWorkflowTemplate(filePath);
  const rawYaml = parseYaml(fs.readFileSync(filePath, "utf8"));

  // Derive repoPath from filePath (.../repoPath/.github/workflows/foo.yml → repoPath)
  const repoPath = path.dirname(path.dirname(path.dirname(filePath)));
  // Resolve ${{ runner.os }} / ${{ runner.arch }} from the job's runs-on so
  // that macOS/Windows jobs don't expand to Linux/X64 (issue #279).
  const runnerContext = runnerContextFromRunsOn(parseJobRunsOn(filePath, taskName));
  // Find the job by ID or Name
  if (!template.jobs) {
    throw new Error(`No jobs found in workflow "${filePath}"`);
  }
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
      const rawStep = rawSteps[index] || {};
      // Prefer raw YAML name to preserve ${{ }} expressions for our own expansion
      const rawName = rawStep.name != null ? String(rawStep.name) : step.name?.toString();
      let stepName = rawName
        ? expandExpressions(
            rawName,
            repoPath,
            secrets,
            matrixContext,
            needsContext,
            inputsContext,
            vars,
            runnerContext,
          )
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
        const expandedScript = expandExpressions(
          rawScript,
          repoPath,
          secrets,
          matrixContext,
          needsContext,
          inputsContext,
          vars,
          runnerContext,
        );
        const shell = resolveStepRunDefault(rawYaml, rawJob, rawStep, "shell");
        const inputs: Record<string, string> = {
          script: shell ? wrapScriptForShell(expandedScript, shell) : expandedScript,
        };
        const workingDirectory = resolveStepRunDefault(
          rawYaml,
          rawJob,
          rawStep,
          "working-directory",
        );
        if (workingDirectory) {
          inputs.workingDirectory = workingDirectory;
        }
        const condition = parseStepIf(rawStep.if);
        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          ContextName: step.id ? step.id.toString() : undefined,
          Reference: {
            Type: "Script",
          },
          Inputs: inputs,
          Env: buildStepEnv(
            rawYaml,
            rawJob,
            rawStep,
            repoPath,
            secrets,
            undefined,
            needsContext,
            inputsContext,
            vars,
            runnerContext,
          ),
          ...(condition !== undefined ? { condition } : {}),
        };
      } else if ("uses" in step) {
        // Basic support for 'uses' steps
        // Parse uses string: owner/repo@ref or ./.github/actions/foo (local)
        const uses = step.uses.toString();
        const isLocalAction = uses.startsWith("./");
        let name = uses;
        let ref = "";

        if (!isLocalAction && uses.indexOf("@") >= 0) {
          const parts = uses.split("@");
          name = parts[0];
          ref = parts[1];
        }

        const isCheckout = !isLocalAction && name.trim().toLowerCase() === "actions/checkout";
        const stepWith = rawStep.with || {};
        const condition = parseStepIf(rawStep.if);

        return {
          Type: "Action",
          Name: stepName,
          DisplayName: stepName,
          Id: crypto.randomUUID(),
          ContextName: step.id ? step.id.toString() : undefined,
          Reference: {
            Type: "Repository",
            Name: isLocalAction ? "" : name,
            Ref: isLocalAction ? "" : ref,
            RepositoryType: isLocalAction ? "self" : "GitHub",
            Path: isLocalAction ? uses : "",
          },
          Inputs: {
            // with: values from @actions/workflow-parser are expression objects; call toString() on each.
            ...((step as any).with
              ? Object.fromEntries(
                  Object.entries((step as any).with).map(([k, v]) => [
                    k,
                    expandExpressions(
                      String(v),
                      repoPath,
                      secrets,
                      matrixContext,
                      needsContext,
                      inputsContext,
                      vars,
                      runnerContext,
                    ),
                  ]),
                )
              : {}),
            // Merge from raw YAML (overrides parsed values), expanding expressions
            ...Object.fromEntries(
              Object.entries(stepWith).map(([k, v]) => [
                k,
                expandExpressions(
                  String(v),
                  repoPath,
                  secrets,
                  matrixContext,
                  needsContext,
                  inputsContext,
                  vars,
                  runnerContext,
                ),
              ]),
            ),
            ...(isCheckout
              ? {
                  clean: "false",
                  "fetch-depth": "0",
                  lfs: "false",
                  submodules: "false",
                  ...Object.fromEntries(
                    Object.entries(stepWith).map(([k, v]) => {
                      let expanded = expandExpressions(
                        String(v),
                        repoPath,
                        secrets,
                        undefined,
                        needsContext,
                        inputsContext,
                        vars,
                        runnerContext,
                      );
                      // The zero hash is a placeholder for "no SHA available" —
                      // normalize it to empty string so actions/checkout uses the
                      // default branch instead of trying to fetch a nonexistent ref.
                      if (k === "ref" && expanded === "0000000000000000000000000000000000000000") {
                        expanded = "";
                      }
                      return [k, expanded];
                    }),
                  ),
                }
              : {}), // Prevent actions/checkout from wiping the rsynced workspace
          },
          Env: buildStepEnv(
            rawYaml,
            rawJob,
            rawStep,
            repoPath,
            secrets,
            matrixContext,
            needsContext,
            inputsContext,
            vars,
            runnerContext,
          ),
          ...(condition !== undefined ? { condition } : {}),
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

type WorkflowEventFilters = {
  branches?: string[];
  "branches-ignore"?: string[];
  paths?: string[];
  "paths-ignore"?: string[];
};

interface WorkflowTemplateLike {
  events?: {
    pull_request?: WorkflowEventFilters;
    push?: WorkflowEventFilters;
    [key: string]: WorkflowEventFilters | undefined;
  };
}

/**
 * Check whether the changed files pass the paths / paths-ignore filter for an
 * event definition. Returns true (relevant) when:
 *  - No changedFiles provided or the array is empty (safe fallback).
 *  - No paths / paths-ignore filters are defined.
 *  - At least one changed file matches a `paths` pattern.
 *  - At least one changed file is NOT matched by all `paths-ignore` patterns.
 */
function matchesPaths(eventDef: WorkflowEventFilters, changedFiles?: string[]): boolean {
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

export function isWorkflowRelevant(
  template: WorkflowTemplateLike,
  branch: string,
  changedFiles?: string[],
) {
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
      `Add the following to ${secretsFilePath} or set them as environment variables:\n\n` +
      missing.map((n) => `${n}=`).join("\n") +
      "\n",
  );
}

/**
 * Scan a workflow file for all `${{ vars.FOO }}` references.
 * If `taskName` is provided, only the YAML subtree for that job is scanned.
 * Returns a sorted, de-duplicated list of var names.
 */
export function extractVarRefs(filePath: string, taskName?: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  // Scope to the job subtree when a taskName is given so we don't pick up
  // vars from other jobs.
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
  for (const m of source.matchAll(/\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    names.add(m[1]);
  }
  return Array.from(names).sort();
}

/**
 * Validate that all vars referenced in a workflow job are present in the
 * provided vars map. Throws with a descriptive message listing the missing
 * var names and the `--var` flags needed to supply them.
 */
export function validateVars(
  filePath: string,
  taskName: string,
  vars: Record<string, string>,
): void {
  const required = extractVarRefs(filePath, taskName);
  const missing = required.filter((name) => !vars[name]);
  if (missing.length === 0) {
    return;
  }
  throw new Error(
    `[Agent CI] Missing vars required by workflow job "${taskName}".\n` +
      `Pass them via --var NAME=value (one flag per variable):\n\n` +
      missing.map((n) => `  --var ${n}=<value>`).join("\n") +
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
 * Normalize a step-level `if:` value into a condition string for the runner's
 * EvaluateStepIf. Accepts the raw YAML value (may be string, boolean, null).
 * Strips a surrounding `${{ }}` wrapper so the runner sees a bare expression,
 * matching the format it uses for the default `success()`.
 * Returns undefined when no condition should be forwarded (the server then
 * defaults to `success()`).
 */
export function parseStepIf(rawIf: unknown): string | undefined {
  if (rawIf === undefined || rawIf === null) {
    return undefined;
  }
  let expr = String(rawIf).trim();
  if (expr === "") {
    return undefined;
  }
  const wrapped = expr.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) {
    expr = wrapped[1].trim();
    if (expr === "") {
      return undefined;
    }
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
/**
 * Parse the `runs-on:` field of a workflow job and return the labels as a flat
 * array of strings. Accepts all three shapes GitHub allows:
 *
 *   - String:        `runs-on: ubuntu-latest`
 *   - Array:         `runs-on: [self-hosted, macos, arm64]`
 *   - Object form:   `runs-on: { group: foo, labels: [x, y] }`
 *
 * Returns an empty array if the job has no `runs-on:` (or the workflow is
 * unparseable). Callers that need to detect a missing value should treat an
 * empty array as "unknown".
 */
export function parseJobRunsOn(filePath: string, jobId: string): string[] {
  const yaml = parseYaml(fs.readFileSync(filePath, "utf8"));
  const raw = yaml?.jobs?.[jobId]?.["runs-on"];
  if (raw == null) {
    return [];
  }
  if (typeof raw === "string") {
    return [raw];
  }
  if (Array.isArray(raw)) {
    return raw.map((v) => String(v));
  }
  if (typeof raw === "object") {
    const labels = (raw as Record<string, unknown>).labels;
    if (Array.isArray(labels)) {
      return labels.map((v) => String(v));
    }
    if (typeof labels === "string") {
      return [labels];
    }
  }
  return [];
}

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
