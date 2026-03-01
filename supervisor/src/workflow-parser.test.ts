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
