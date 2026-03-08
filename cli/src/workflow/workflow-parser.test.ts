import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWorkflowServices } from "./workflow-parser.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const WORKFLOW_WITH_SERVICES = `
name: Unit Tests
on: [push]
jobs:
  unit-tests:
    runs-on: ubuntu-latest
    services:
      mysql:
        image: mysql:8.0
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: test_db
          MYSQL_USER: app
          MYSQL_PASSWORD: app
        options: >-
          --health-cmd="mysqladmin ping -h localhost -proot"
          --health-interval=5s
          --health-timeout=3s
          --health-retries=10
        ports:
          - 3306:3306
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_NO_SERVICES = `
name: Simple
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`.trimStart();

const WORKFLOW_SERVICE_NO_PORTS = `
name: Minimal Service
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: secret
    steps:
      - run: echo hi
`.trimStart();

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("parseWorkflowServices", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-svc-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses MySQL service with env, ports, and health check options", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_SERVICES);
    const services = await parseWorkflowServices(filePath, "unit-tests");

    expect(services).toHaveLength(2);

    const mysql = services.find((s) => s.name === "mysql")!;
    expect(mysql).toBeDefined();
    expect(mysql.image).toBe("mysql:8.0");
    expect(mysql.env).toEqual({
      MYSQL_ROOT_PASSWORD: "root",
      MYSQL_DATABASE: "test_db",
      MYSQL_USER: "app",
      MYSQL_PASSWORD: "app",
    });
    expect(mysql.ports).toEqual(["3306:3306"]);
    expect(mysql.options).toContain("--health-cmd");
    expect(mysql.options).toContain("--health-interval=5s");
  });

  it("parses Redis service with ports but no env or options", async () => {
    const filePath = writeWorkflow(WORKFLOW_WITH_SERVICES);
    const services = await parseWorkflowServices(filePath, "unit-tests");

    const redis = services.find((s) => s.name === "redis")!;
    expect(redis).toBeDefined();
    expect(redis.image).toBe("redis:7");
    expect(redis.ports).toEqual(["6379:6379"]);
    expect(redis.env).toBeUndefined();
    expect(redis.options).toBeUndefined();
  });

  it("returns empty array when job has no services", async () => {
    const filePath = writeWorkflow(WORKFLOW_NO_SERVICES);
    const services = await parseWorkflowServices(filePath, "build");

    expect(services).toEqual([]);
  });

  it("returns empty array when job doesn't exist", async () => {
    const filePath = writeWorkflow(WORKFLOW_NO_SERVICES);
    const services = await parseWorkflowServices(filePath, "nonexistent");

    expect(services).toEqual([]);
  });

  it("parses service with env but no ports", async () => {
    const filePath = writeWorkflow(WORKFLOW_SERVICE_NO_PORTS);
    const services = await parseWorkflowServices(filePath, "test");

    expect(services).toHaveLength(1);
    const pg = services[0];
    expect(pg.name).toBe("postgres");
    expect(pg.image).toBe("postgres:16");
    expect(pg.env).toEqual({ POSTGRES_PASSWORD: "secret" });
    expect(pg.ports).toBeUndefined();
    expect(pg.options).toBeUndefined();
  });

  it("converts env values to strings", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-svc-test-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(
      filePath,
      `name: Env Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      db:
        image: mysql:8.0
        env:
          PORT: 3306
          SKIP_TZINFO: 1
          DEBUG: true
    steps:
      - run: echo hi
`,
    );

    const services = await parseWorkflowServices(filePath, "test");
    const db = services[0];
    // Numeric and boolean YAML values should be coerced to strings
    expect(db.env!.PORT).toBe("3306");
    expect(db.env!.SKIP_TZINFO).toBe("1");
    expect(db.env!.DEBUG).toBe("true");
  });
});

// ─── expandExpressions ────────────────────────────────────────────────────────

import { expandExpressions } from "./workflow-parser.js";

describe("expandExpressions", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeRepo(...files: { name: string; content: string }[]): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-expr-test-"));
    for (const { name, content } of files) {
      const full = path.join(tmpDir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    return tmpDir;
  }

  // ── passthrough ──────────────────────────────────────────────────────────────

  it("returns plain strings unchanged", () => {
    expect(expandExpressions("hello-world")).toBe("hello-world");
    expect(expandExpressions("")).toBe("");
    expect(expandExpressions("Linux-vite-build-abc123")).toBe("Linux-vite-build-abc123");
  });

  // ── context variables ────────────────────────────────────────────────────────

  it("expands runner.os to Linux", () => {
    expect(expandExpressions("${{ runner.os }}-build")).toBe("Linux-build");
  });

  it("expands runner.arch to X64", () => {
    expect(expandExpressions("prefix-${{ runner.arch }}")).toBe("prefix-X64");
  });

  it("expands github.run_id to '1'", () => {
    expect(expandExpressions("cache-${{ github.run_id }}")).toBe("cache-1");
  });

  it("expands github.run_number to '1'", () => {
    expect(expandExpressions("run-${{ github.run_number }}")).toBe("run-1");
  });

  it("expands github.sha to zeros", () => {
    expect(expandExpressions("sha-${{ github.sha }}")).toBe(
      "sha-0000000000000000000000000000000000000000",
    );
  });

  it("expands github.ref_name to main", () => {
    expect(expandExpressions("branch-${{ github.ref_name }}")).toBe("branch-main");
  });

  it("expands github.repository", () => {
    expect(expandExpressions("${{ github.repository }}")).toBe("local/repo");
  });

  it("expands secrets.* to empty string when no secrets map provided", () => {
    expect(expandExpressions("token=${{ secrets.MY_TOKEN }}")).toBe("token=");
  });

  it("expands secrets.* to empty string when key is absent from secrets map", () => {
    expect(expandExpressions("token=${{ secrets.MISSING }}", undefined, { OTHER: "value" })).toBe(
      "token=",
    );
  });

  it("expands secrets.* from provided secrets map", () => {
    expect(
      expandExpressions("token=${{ secrets.MY_TOKEN }}", undefined, { MY_TOKEN: "abc123" }),
    ).toBe("token=abc123");
  });

  it("expands multiple secrets from provided secrets map", () => {
    const secrets = { API_TOKEN: "tok-xyz", ACCOUNT_ID: "acc-123" };
    expect(
      expandExpressions("${{ secrets.API_TOKEN }}:${{ secrets.ACCOUNT_ID }}", undefined, secrets),
    ).toBe("tok-xyz:acc-123");
  });

  it("expands matrix.* to empty string when no matrixContext provided", () => {
    expect(expandExpressions("shard-${{ matrix.shard }}")).toBe("shard-");
  });

  it("expands steps.* to empty string", () => {
    expect(expandExpressions("hit-${{ steps.cache.outputs.cache-hit }}")).toBe("hit-");
    expect(expandExpressions("${{ steps.some-step.outputs.result }}")).toBe("");
  });

  it("expands needs.* to empty string", () => {
    expect(expandExpressions("${{ needs.build.result }}")).toBe("");
  });

  it("expands unknown expressions to empty string (no commas injected)", () => {
    expect(expandExpressions("${{ some.unknown.expr }}")).toBe("");
    // Especially important: unknown expressions must NOT contain commas
    const result = expandExpressions("key-${{ something.weird('a','b') }}");
    expect(result).not.toContain(",");
  });

  // ── compound strings ─────────────────────────────────────────────────────────

  it("expands multiple expressions in one string", () => {
    const result = expandExpressions("${{ runner.os }}-build-${{ github.run_id }}");
    expect(result).toBe("Linux-build-1");
  });

  it("produces a cache key with no commas even for multi-arg hashFiles", () => {
    const repoDir = makeRepo({ name: "package.json", content: "{}" });
    const result = expandExpressions(
      "${{ runner.os }}-vite-build-${{ hashFiles('package.json', 'pnpm-lock.yaml') }}",
      repoDir,
    );
    expect(result).not.toContain(",");
    expect(result).toMatch(/^Linux-vite-build-[0-9a-f]+$/);
  });

  // ── hashFiles ────────────────────────────────────────────────────────────────

  it("hashFiles with a matching file returns a hex sha256", () => {
    const repoDir = makeRepo({ name: "pnpm-lock.yaml", content: "lockfile: v6" });
    const result = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashFiles is deterministic for the same file content", () => {
    const repoDir = makeRepo({ name: "pnpm-lock.yaml", content: "lockfile: v6" });
    const a = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    const b = expandExpressions("${{ hashFiles('pnpm-lock.yaml') }}", repoDir);
    expect(a).toBe(b);
  });

  it("hashFiles changes when file content changes", () => {
    const repoDir = makeRepo({ name: "lock.yaml", content: "version: 1" });
    const before = expandExpressions("${{ hashFiles('lock.yaml') }}", repoDir);
    fs.writeFileSync(path.join(repoDir, "lock.yaml"), "version: 2");
    const after = expandExpressions("${{ hashFiles('lock.yaml') }}", repoDir);
    expect(before).not.toBe(after);
  });

  it("hashFiles with multiple matching patterns combines all files", () => {
    const repoDir = makeRepo(
      { name: "package.json", content: "{}" },
      { name: "pnpm-lock.yaml", content: "lockfile: v6" },
    );
    const both = expandExpressions("${{ hashFiles('package.json', 'pnpm-lock.yaml') }}", repoDir);
    const justPackage = expandExpressions("${{ hashFiles('package.json') }}", repoDir);
    // Hash of both files is different from hash of just one
    expect(both).toMatch(/^[0-9a-f]{64}$/);
    expect(both).not.toBe(justPackage);
  });

  it("hashFiles with no matching files returns zero hash", () => {
    const repoDir = makeRepo({ name: "package.json", content: "{}" });
    const result = expandExpressions("${{ hashFiles('nonexistent.txt') }}", repoDir);
    expect(result).toBe("0000000000000000000000000000000000000000");
  });

  it("hashFiles without repoPath returns zero hash", () => {
    const result = expandExpressions("${{ hashFiles('package.json') }}");
    expect(result).toBe("0000000000000000000000000000000000000000");
  });

  it("hashFiles matches glob patterns", () => {
    const repoDir = makeRepo(
      { name: "src/foo.ts", content: "const x = 1" },
      { name: "src/bar.ts", content: "const y = 2" },
    );
    const result = expandExpressions("${{ hashFiles('src/**/*.ts') }}", repoDir);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── expandExpressions — matrixContext ────────────────────────────────────────

describe("expandExpressions with matrixContext", () => {
  it("expands matrix.shard to the provided shard value", () => {
    expect(
      expandExpressions("shard-${{ matrix.shard }}", undefined, undefined, { shard: "3" }),
    ).toBe("shard-3");
  });

  it("expands strategy.job-total to __job_total from context", () => {
    expect(
      expandExpressions("total-${{ strategy.job-total }}", undefined, undefined, {
        __job_total: "8",
      }),
    ).toBe("total-8");
  });

  it("expands both matrix.shard and strategy.job-total in a real command", () => {
    const result = expandExpressions(
      "pnpm test:e2e:ci --shard=${{ matrix.shard }}/${{ strategy.job-total }}",
      undefined,
      undefined,
      { shard: "3", __job_total: "8" },
    );
    expect(result).toBe("pnpm test:e2e:ci --shard=3/8");
  });

  it("returns empty string for matrix.* when matrixContext not provided", () => {
    expect(expandExpressions("shard-${{ matrix.shard }}")).toBe("shard-");
  });

  it("returns fallback '1' for strategy.job-total when context not provided", () => {
    expect(expandExpressions("${{ strategy.job-total }}")).toBe("1");
  });
});

// ─── expandMatrixCombinations ─────────────────────────────────────────────────

import { expandMatrixCombinations } from "./workflow-parser.js";

describe("expandMatrixCombinations", () => {
  it("returns [{}] for an empty matrix", () => {
    expect(expandMatrixCombinations({})).toEqual([{}]);
  });

  it("returns one combination per value for a single dimension", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2, 3] });
    expect(combos).toHaveLength(3);
    expect(combos[0]).toEqual({ shard: "1" });
    expect(combos[1]).toEqual({ shard: "2" });
    expect(combos[2]).toEqual({ shard: "3" });
  });

  it("coerces numeric values to strings", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2] });
    expect(typeof combos[0].shard).toBe("string");
  });

  it("returns 8 combinations for shard [1..8]", () => {
    const combos = expandMatrixCombinations({ shard: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(combos).toHaveLength(8);
    expect(combos[7]).toEqual({ shard: "8" });
  });

  it("returns Cartesian product for multi-dimensional matrix", () => {
    const combos = expandMatrixCombinations({ os: ["ubuntu", "windows"], node: [18, 20] });
    expect(combos).toHaveLength(4);
    // All four combinations must be present
    expect(combos).toContainEqual({ os: "ubuntu", node: "18" });
    expect(combos).toContainEqual({ os: "ubuntu", node: "20" });
    expect(combos).toContainEqual({ os: "windows", node: "18" });
    expect(combos).toContainEqual({ os: "windows", node: "20" });
  });
});

// ─── loadMachineSecrets ───────────────────────────────────────────────────────

// Inline the parser logic rather than importing from config.ts to avoid
// the module-level `configSchema.parse(process.env)` ZodError in test env.
function loadMachineSecrets(baseDir: string): Record<string, string> {
  const envMachinePath = path.join(baseDir, ".env.machine");
  if (!fs.existsSync(envMachinePath)) {
    return {};
  }
  const secrets: Record<string, string> = {};
  for (const line of fs.readFileSync(envMachinePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      continue;
    }
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      secrets[key] = value;
    }
  }
  return secrets;
}

describe("loadMachineSecrets", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeMachineEnv(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-test-"));
    fs.writeFileSync(path.join(tmpDir, ".env.machine"), content);
    return tmpDir;
  }

  it("returns empty object when .env.machine does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-test-"));
    // No .env.machine written — file simply absent
    const secrets = loadMachineSecrets(tmpDir);
    expect(secrets).toEqual({});
  });

  it("parses KEY=VALUE pairs into a record", () => {
    const dir = writeMachineEnv(
      "CLOUDFLARE_API_TOKEN=my-fake-cf-token\nCLOUDFLARE_ACCOUNT_ID=acct-abc123\n",
    );
    const secrets = loadMachineSecrets(dir);
    expect(secrets).toEqual({
      CLOUDFLARE_API_TOKEN: "my-fake-cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-abc123",
    });
  });

  it("ignores comment lines and blank lines", () => {
    const dir = writeMachineEnv(
      `# This is a comment
API_KEY=super-secret-key-xyz

# Another comment
OTHER_TOKEN=tok-456
`,
    );
    const secrets = loadMachineSecrets(dir);
    expect(secrets).toEqual({
      API_KEY: "super-secret-key-xyz",
      OTHER_TOKEN: "tok-456",
    });
  });

  it("strips surrounding double quotes from values", () => {
    const dir = writeMachineEnv('QUOTED_TOKEN="my-quoted-token"\n');
    const secrets = loadMachineSecrets(dir);
    expect(secrets["QUOTED_TOKEN"]).toBe("my-quoted-token");
  });

  it("strips surrounding single quotes from values", () => {
    const dir = writeMachineEnv("SINGLE_QUOTED='my-single-quoted'\n");
    const secrets = loadMachineSecrets(dir);
    expect(secrets["SINGLE_QUOTED"]).toBe("my-single-quoted");
  });

  it("handles values containing equals signs", () => {
    const dir = writeMachineEnv("URL=https://example.com?foo=bar&baz=qux\n");
    const secrets = loadMachineSecrets(dir);
    expect(secrets["URL"]).toBe("https://example.com?foo=bar&baz=qux");
  });
});

// ─── extractSecretRefs & validateSecrets ──────────────────────────────────────

import { extractSecretRefs, validateSecrets } from "./workflow-parser.js";

describe("extractSecretRefs", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-secrets-refs-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns empty array when workflow has no secrets references", () => {
    const filePath = writeWorkflow(`
name: No Secrets
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
`);
    expect(extractSecretRefs(filePath)).toEqual([]);
  });

  it("extracts unique sorted secret names from the whole file", () => {
    const filePath = writeWorkflow(`
name: Secrets Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.API_TOKEN }}
      ACCT: \${{ secrets.ACCOUNT_ID }}
      DUP: \${{ secrets.API_TOKEN }}
    steps:
      - run: echo ok
`);
    expect(extractSecretRefs(filePath)).toEqual(["ACCOUNT_ID", "API_TOKEN"]);
  });

  it("scopes to the specified job when taskName is provided", () => {
    const filePath = writeWorkflow(`
name: Multi Job
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.BUILD_TOKEN }}
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.TEST_TOKEN }}
    steps:
      - run: echo test
`);
    expect(extractSecretRefs(filePath, "test")).toEqual(["TEST_TOKEN"]);
    expect(extractSecretRefs(filePath, "build")).toEqual(["BUILD_TOKEN"]);
  });
});

describe("validateSecrets", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflow(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-validate-"));
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("does not throw when all required secrets are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.MY_TOKEN }}
    steps:
      - run: echo ok
`);
    expect(() =>
      validateSecrets(filePath, "run", { MY_TOKEN: "abc123" }, "/repo/.env.machinen"),
    ).not.toThrow();
  });

  it("does not throw when workflow has no secrets", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(() => validateSecrets(filePath, "run", {}, "/repo/.env.machinen")).not.toThrow();
  });

  it("throws listing missing secrets and the secrets file path", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CF_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
      CF_ACCT: \${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - run: echo deploy
`);
    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.machinen")).toThrow(
      /CLOUDFLARE_ACCOUNT_ID=/,
    );

    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.machinen")).toThrow(
      /CLOUDFLARE_API_TOKEN=/,
    );

    expect(() => validateSecrets(filePath, "deploy", {}, "/home/user/repo/.env.machinen")).toThrow(
      /\/home\/user\/repo\/.env.machinen/,
    );
  });

  it("only fails for missing secrets, not for ones that are present", () => {
    const filePath = writeWorkflow(`
name: Test
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    env:
      A: \${{ secrets.PRESENT_SECRET }}
      B: \${{ secrets.MISSING_SECRET }}
    steps:
      - run: echo ok
`);
    expect(() =>
      validateSecrets(filePath, "run", { PRESENT_SECRET: "value" }, "/repo/.env.machinen"),
    ).toThrow(/MISSING_SECRET/);

    expect(() =>
      validateSecrets(filePath, "run", { PRESENT_SECRET: "value" }, "/repo/.env.machinen"),
    ).not.toThrow(/PRESENT_SECRET/);
  });
});
