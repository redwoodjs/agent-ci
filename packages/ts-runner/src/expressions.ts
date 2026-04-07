/**
 * GitHub Actions expression evaluator.
 *
 * Evaluates `${{ }}` expressions used in workflow files. Supports:
 * - Property access: `github.actor`, `steps.build.outputs.result`
 * - Functions: `success()`, `failure()`, `always()`, `cancelled()`,
 *   `contains()`, `startsWith()`, `endsWith()`, `format()`, `join()`,
 *   `toJSON()`, `fromJSON()`, `hashFiles()`
 * - Operators: `==`, `!=`, `&&`, `||`, `!`, `<`, `<=`, `>`, `>=`
 * - Literals: strings ('...'), numbers, booleans (true/false), null
 *
 * Reference: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/evaluate-expressions
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpressionValue =
  | string
  | number
  | boolean
  | null
  | ExpressionValue[]
  | { [key: string]: ExpressionValue };

export interface ExpressionContext {
  github: Record<string, ExpressionValue>;
  env: Record<string, string>;
  secrets: Record<string, string>;
  matrix: Record<string, string>;
  steps: Record<string, { outputs: Record<string, string>; outcome: string; conclusion: string }>;
  needs: Record<string, { outputs: Record<string, string>; result: string }>;
  runner: Record<string, string>;
  job: Record<string, ExpressionValue>;
  inputs: Record<string, string>;
  /** Workspace root for hashFiles() resolution */
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

enum TokenType {
  String,
  Number,
  Boolean,
  Null,
  Ident,
  Dot,
  LParen,
  RParen,
  LBracket,
  RBracket,
  Comma,
  Eq,
  Neq,
  Lt,
  Le,
  Gt,
  Ge,
  And,
  Or,
  Not,
  EOF,
}

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) {
      i++;
      continue;
    }

    const pos = i;

    // Two-char operators
    if (i + 1 < input.length) {
      const two = input.slice(i, i + 2);
      if (two === "==") {
        tokens.push({ type: TokenType.Eq, value: two, pos });
        i += 2;
        continue;
      }
      if (two === "!=") {
        tokens.push({ type: TokenType.Neq, value: two, pos });
        i += 2;
        continue;
      }
      if (two === "<=") {
        tokens.push({ type: TokenType.Le, value: two, pos });
        i += 2;
        continue;
      }
      if (two === ">=") {
        tokens.push({ type: TokenType.Ge, value: two, pos });
        i += 2;
        continue;
      }
      if (two === "&&") {
        tokens.push({ type: TokenType.And, value: two, pos });
        i += 2;
        continue;
      }
      if (two === "||") {
        tokens.push({ type: TokenType.Or, value: two, pos });
        i += 2;
        continue;
      }
    }

    // Single-char tokens
    const ch = input[i];
    if (ch === "(") {
      tokens.push({ type: TokenType.LParen, value: ch, pos });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: TokenType.RParen, value: ch, pos });
      i++;
      continue;
    }
    if (ch === "[") {
      tokens.push({ type: TokenType.LBracket, value: ch, pos });
      i++;
      continue;
    }
    if (ch === "]") {
      tokens.push({ type: TokenType.RBracket, value: ch, pos });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: TokenType.Comma, value: ch, pos });
      i++;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: TokenType.Dot, value: ch, pos });
      i++;
      continue;
    }
    if (ch === "<") {
      tokens.push({ type: TokenType.Lt, value: ch, pos });
      i++;
      continue;
    }
    if (ch === ">") {
      tokens.push({ type: TokenType.Gt, value: ch, pos });
      i++;
      continue;
    }
    if (ch === "!") {
      tokens.push({ type: TokenType.Not, value: ch, pos });
      i++;
      continue;
    }

    // String literal (single-quoted)
    if (ch === "'") {
      let str = "";
      i++; // skip opening quote
      while (i < input.length && input[i] !== "'") {
        if (input[i] === "'" && i + 1 < input.length && input[i + 1] === "'") {
          str += "'"; // escaped quote
          i += 2;
        } else {
          str += input[i];
          i++;
        }
      }
      i++; // skip closing quote
      tokens.push({ type: TokenType.String, value: str, pos });
      continue;
    }

    // Number
    if (/[\d]/.test(ch) || (ch === "-" && i + 1 < input.length && /[\d]/.test(input[i + 1]))) {
      let num = ch;
      i++;
      while (i < input.length && /[\d.]/.test(input[i])) {
        num += input[i];
        i++;
      }
      // Check for hex
      if (num === "0" && i < input.length && input[i] === "x") {
        num += input[i];
        i++;
        while (i < input.length && /[\da-fA-F]/.test(input[i])) {
          num += input[i];
          i++;
        }
      }
      tokens.push({ type: TokenType.Number, value: num, pos });
      continue;
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = ch;
      i++;
      while (i < input.length && /[a-zA-Z0-9_-]/.test(input[i])) {
        ident += input[i];
        i++;
      }
      if (ident === "true" || ident === "false") {
        tokens.push({ type: TokenType.Boolean, value: ident, pos });
      } else if (ident === "null") {
        tokens.push({ type: TokenType.Null, value: ident, pos });
      } else {
        tokens.push({ type: TokenType.Ident, value: ident, pos });
      }
      continue;
    }

    // Unknown character — skip
    i++;
  }

  tokens.push({ type: TokenType.EOF, value: "", pos: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser — recursive descent producing an AST
// ---------------------------------------------------------------------------

type Expr =
  | { kind: "literal"; value: ExpressionValue }
  | { kind: "context"; path: string[] }
  | { kind: "index"; object: Expr; index: Expr }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "not"; operand: Expr }
  | {
      kind: "binary";
      op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";
      left: Expr;
      right: Expr;
    };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos] || { type: TokenType.EOF, value: "", pos: -1 };
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(type: TokenType): Token {
    const t = this.advance();
    if (t.type !== type) {
      throw new Error(
        `Expected ${TokenType[type]} but got ${TokenType[t.type]} ("${t.value}") at position ${t.pos}`,
      );
    }
    return t;
  }

  parse(): Expr {
    const expr = this.parseOr();
    return expr;
  }

  // Precedence (lowest to highest): ||, &&, ==|!=|<|<=|>|>=, !, primary
  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek().type === TokenType.Or) {
      this.advance();
      const right = this.parseAnd();
      left = { kind: "binary", op: "||", left, right };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.peek().type === TokenType.And) {
      this.advance();
      const right = this.parseComparison();
      left = { kind: "binary", op: "&&", left, right };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseUnary();
    const t = this.peek();
    if (
      t.type === TokenType.Eq ||
      t.type === TokenType.Neq ||
      t.type === TokenType.Lt ||
      t.type === TokenType.Le ||
      t.type === TokenType.Gt ||
      t.type === TokenType.Ge
    ) {
      const op = this.advance().value as "==" | "!=" | "<" | "<=" | ">" | ">=";
      const right = this.parseUnary();
      left = { kind: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().type === TokenType.Not) {
      this.advance();
      const operand = this.parseUnary();
      return { kind: "not", operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.peek();

    // Parenthesized expression
    if (t.type === TokenType.LParen) {
      this.advance();
      const expr = this.parseOr();
      this.expect(TokenType.RParen);
      return expr;
    }

    // String literal
    if (t.type === TokenType.String) {
      this.advance();
      return { kind: "literal", value: t.value };
    }

    // Number literal
    if (t.type === TokenType.Number) {
      this.advance();
      return { kind: "literal", value: Number(t.value) };
    }

    // Boolean literal
    if (t.type === TokenType.Boolean) {
      this.advance();
      return { kind: "literal", value: t.value === "true" };
    }

    // Null literal
    if (t.type === TokenType.Null) {
      this.advance();
      return { kind: "literal", value: null };
    }

    // Identifier — could be context access or function call
    if (t.type === TokenType.Ident) {
      this.advance();
      const name = t.value;

      // Function call: ident(args...)
      if (this.peek().type === TokenType.LParen) {
        // But first check if next-next is RParen or an arg — this IS a function call
        this.advance(); // consume (
        const args: Expr[] = [];
        if (this.peek().type !== TokenType.RParen) {
          args.push(this.parseOr());
          while (this.peek().type === TokenType.Comma) {
            this.advance();
            args.push(this.parseOr());
          }
        }
        this.expect(TokenType.RParen);
        return { kind: "call", name, args };
      }

      // Context access: ident.prop.prop or ident['key']
      const pathParts: string[] = [name];
      let base: Expr = { kind: "context", path: pathParts };

      while (true) {
        if (this.peek().type === TokenType.Dot) {
          this.advance();
          const prop = this.expect(TokenType.Ident);
          pathParts.push(prop.value);
        } else if (this.peek().type === TokenType.LBracket) {
          this.advance();
          const index = this.parseOr();
          this.expect(TokenType.RBracket);
          // If we've been building a context path, convert to index expression
          base = { kind: "index", object: base, index };
          // Can't keep appending to pathParts after a dynamic index
          return base;
        } else {
          break;
        }
      }

      return base;
    }

    // Negative number (unary minus)
    if (t.type === TokenType.Number) {
      this.advance();
      return { kind: "literal", value: Number(t.value) };
    }

    throw new Error(`Unexpected token: ${TokenType[t.type]} ("${t.value}") at position ${t.pos}`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function resolveContext(pathParts: string[], ctx: ExpressionContext): ExpressionValue {
  const root = pathParts[0];
  let value: ExpressionValue;

  switch (root) {
    case "github":
      value = ctx.github;
      break;
    case "env":
      value = ctx.env;
      break;
    case "secrets":
      value = ctx.secrets;
      break;
    case "matrix":
      value = ctx.matrix;
      break;
    case "runner":
      value = ctx.runner;
      break;
    case "job":
      value = ctx.job;
      break;
    case "inputs":
      value = ctx.inputs;
      break;
    case "steps": {
      // steps.id.outputs.name or steps.id.outcome/conclusion
      const stepId = pathParts[1];
      if (!stepId) {
        return ctx.steps;
      }
      const step = ctx.steps[stepId];
      if (!step) {
        return "";
      }
      if (pathParts[2] === "outputs") {
        return pathParts[3] ? (step.outputs[pathParts[3]] ?? "") : step.outputs;
      }
      if (pathParts[2] === "outcome") {
        return step.outcome;
      }
      if (pathParts[2] === "conclusion") {
        return step.conclusion;
      }
      return "";
    }
    case "needs": {
      const jobId = pathParts[1];
      if (!jobId) {
        return ctx.needs;
      }
      const job = ctx.needs[jobId];
      if (!job) {
        return "";
      }
      if (pathParts[2] === "outputs") {
        return pathParts[3] ? (job.outputs[pathParts[3]] ?? "") : job.outputs;
      }
      if (pathParts[2] === "result") {
        return job.result;
      }
      return "";
    }
    default:
      return "";
  }

  // Walk remaining path
  for (let i = 1; i < pathParts.length; i++) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      return "";
    }
    value = (value as Record<string, ExpressionValue>)[pathParts[i]] ?? "";
  }

  return value ?? "";
}

/** Coerce a value to string (GitHub Actions coercion rules). */
function coerceToString(v: ExpressionValue): string {
  if (v === null) {
    return "";
  }
  if (typeof v === "boolean") {
    return v ? "true" : "false";
  }
  if (typeof v === "number") {
    return String(v);
  }
  if (typeof v === "string") {
    return v;
  }
  return JSON.stringify(v);
}

/** Coerce a value to boolean (GitHub Actions truthiness). */
function coerceToBool(v: ExpressionValue): boolean {
  if (v === null) {
    return false;
  }
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  if (typeof v === "string") {
    return v !== "" && v !== "0" && v !== "false";
  }
  return true;
}

/** Compare two values with type coercion (GitHub Actions rules). */
function compareValues(left: ExpressionValue, right: ExpressionValue): number {
  // Null comparisons
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return typeof right === "number" ? -right : -1;
  }
  if (right === null) {
    return typeof left === "number" ? (left as number) : 1;
  }

  // If both are numbers, compare numerically
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  // If one is a number, try to coerce the other
  if (typeof left === "number" && typeof right === "string") {
    const n = Number(right);
    if (!isNaN(n)) {
      return left - n;
    }
  }
  if (typeof right === "number" && typeof left === "string") {
    const n = Number(left);
    if (!isNaN(n)) {
      return n - right;
    }
  }

  // String comparison (case-insensitive for == and !=)
  const ls = coerceToString(left).toLowerCase();
  const rs = coerceToString(right).toLowerCase();
  if (ls < rs) {
    return -1;
  }
  if (ls > rs) {
    return 1;
  }
  return 0;
}

function hashFilesImpl(patterns: string[], workspace: string): string {
  const hash = crypto.createHash("sha256");
  let hasAny = false;

  for (const pattern of patterns) {
    const files = findFiles(workspace, pattern);
    for (const f of files.sort()) {
      try {
        hash.update(fs.readFileSync(f));
        hasAny = true;
      } catch {
        // skip unreadable files
      }
    }
  }

  return hasAny ? hash.digest("hex") : "";
}

function findFiles(rootDir: string, pattern: string): string[] {
  // Simple recursive glob — import minimatch if available, otherwise basic matching
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
      } else if (simpleMatch(relChild, normPattern)) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  walk(rootDir, "");
  return results;
}

/** Minimal glob matching — supports * and **. For production, use minimatch. */
function simpleMatch(filepath: string, pattern: string): boolean {
  const regex = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*")
    .replace(/\?/g, "[^/]")
    .replace(/\./g, "\\.");
  return new RegExp(`^${regex}$`).test(filepath);
}

function evaluateExpr(expr: Expr, ctx: ExpressionContext): ExpressionValue {
  switch (expr.kind) {
    case "literal":
      return expr.value;

    case "context":
      return resolveContext(expr.path, ctx);

    case "index": {
      const obj = evaluateExpr(expr.object, ctx);
      const idx = evaluateExpr(expr.index, ctx);
      if (obj == null || typeof obj !== "object") {
        return "";
      }
      const key = coerceToString(idx);
      if (Array.isArray(obj)) {
        const i = parseInt(key, 10);
        return isNaN(i) ? "" : (obj[i] ?? "");
      }
      return (obj as Record<string, ExpressionValue>)[key] ?? "";
    }

    case "not":
      return !coerceToBool(evaluateExpr(expr.operand, ctx));

    case "binary": {
      // Short-circuit for && and ||
      if (expr.op === "&&") {
        const left = evaluateExpr(expr.left, ctx);
        if (!coerceToBool(left)) {
          return left;
        }
        return evaluateExpr(expr.right, ctx);
      }
      if (expr.op === "||") {
        const left = evaluateExpr(expr.left, ctx);
        if (coerceToBool(left)) {
          return left;
        }
        return evaluateExpr(expr.right, ctx);
      }

      const left = evaluateExpr(expr.left, ctx);
      const right = evaluateExpr(expr.right, ctx);
      const cmp = compareValues(left, right);

      switch (expr.op) {
        case "==":
          return cmp === 0;
        case "!=":
          return cmp !== 0;
        case "<":
          return cmp < 0;
        case "<=":
          return cmp <= 0;
        case ">":
          return cmp > 0;
        case ">=":
          return cmp >= 0;
      }
      return false;
    }

    case "call":
      return evaluateFunction(expr.name, expr.args, ctx);
  }
}

function evaluateFunction(name: string, argExprs: Expr[], ctx: ExpressionContext): ExpressionValue {
  switch (name) {
    case "success": {
      // All upstream jobs/steps succeeded (or no upstream)
      const stepValues = Object.values(ctx.steps);
      if (stepValues.length === 0) {
        return true;
      }
      return stepValues.every((s) => s.conclusion === "success" || s.conclusion === "skipped");
    }

    case "failure": {
      return Object.values(ctx.steps).some((s) => s.conclusion === "failure");
    }

    case "always":
      return true;

    case "cancelled":
      return false; // Local runs don't get cancelled

    case "contains": {
      const search = evaluateExpr(argExprs[0], ctx);
      const item = evaluateExpr(argExprs[1], ctx);
      if (Array.isArray(search)) {
        const itemStr = coerceToString(item).toLowerCase();
        return search.some((v) => coerceToString(v).toLowerCase() === itemStr);
      }
      return coerceToString(search).toLowerCase().includes(coerceToString(item).toLowerCase());
    }

    case "startsWith": {
      const str = coerceToString(evaluateExpr(argExprs[0], ctx)).toLowerCase();
      const prefix = coerceToString(evaluateExpr(argExprs[1], ctx)).toLowerCase();
      return str.startsWith(prefix);
    }

    case "endsWith": {
      const str = coerceToString(evaluateExpr(argExprs[0], ctx)).toLowerCase();
      const suffix = coerceToString(evaluateExpr(argExprs[1], ctx)).toLowerCase();
      return str.endsWith(suffix);
    }

    case "format": {
      const template = coerceToString(evaluateExpr(argExprs[0], ctx));
      const args = argExprs.slice(1).map((a) => coerceToString(evaluateExpr(a, ctx)));
      return template.replace(/\{(\d+)\}/g, (_m, idx) => {
        const i = parseInt(idx, 10);
        return i < args.length ? args[i] : "";
      });
    }

    case "join": {
      const arr = evaluateExpr(argExprs[0], ctx);
      const sep = argExprs.length > 1 ? coerceToString(evaluateExpr(argExprs[1], ctx)) : ",";
      if (Array.isArray(arr)) {
        return arr.map((v) => coerceToString(v)).join(sep);
      }
      return coerceToString(arr);
    }

    case "toJSON": {
      const val = evaluateExpr(argExprs[0], ctx);
      return JSON.stringify(val);
    }

    case "fromJSON": {
      const str = coerceToString(evaluateExpr(argExprs[0], ctx));
      try {
        return JSON.parse(str) as ExpressionValue;
      } catch {
        return str;
      }
    }

    case "hashFiles": {
      const patterns = argExprs.map((a) => coerceToString(evaluateExpr(a, ctx)));
      if (!ctx.workspace) {
        return "";
      }
      return hashFilesImpl(patterns, ctx.workspace);
    }

    default:
      throw new Error(`Unknown function: ${name}()`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a single expression string (without `${{ }}` delimiters).
 *
 * Returns the raw value — callers can coerce with `coerceToString()`.
 */
export function evaluate(expression: string, ctx: ExpressionContext): ExpressionValue {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parse();
  return evaluateExpr(ast, ctx);
}

/**
 * Interpolate a string containing `${{ }}` expressions.
 *
 * Non-expression text is preserved as-is. Expression results are coerced to strings.
 */
export function interpolate(template: string, ctx: ExpressionContext): string {
  return template.replace(/\$\{\{([\s\S]*?)\}\}/g, (_match, expr: string) => {
    try {
      const result = evaluate(expr.trim(), ctx);
      return coerceToString(result);
    } catch {
      return "";
    }
  });
}

/**
 * Evaluate a condition expression (used for `if:` on steps and jobs).
 *
 * Returns a boolean. If the expression is empty, defaults to `success()`.
 */
export function evaluateCondition(expression: string, ctx: ExpressionContext): boolean {
  if (!expression.trim()) {
    return coerceToBool(evaluateFunction("success", [], ctx));
  }

  // Strip ${{ }} wrapper if present
  let expr = expression.trim();
  const wrapped = expr.match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (wrapped) {
    expr = wrapped[1];
  }

  return coerceToBool(evaluate(expr, ctx));
}

export { coerceToString, coerceToBool };
