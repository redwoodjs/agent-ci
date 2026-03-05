import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { app } from "./index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow, retryRun } from "./orchestrator.js";

describe("Supervisor Server API", () => {
  it("GET /status returns valid status response", async () => {
    const res = await request(app.handler as any).get("/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status");
    expect(typeof res.body.status).toBe("string");
    expect(["Idle", "Running", "Passed", "Failed"]).toContain(res.body.status);
    expect(res.body).toHaveProperty("activeContainers");
    expect(res.body).toHaveProperty("recentJobs");
  });

  it("POST /repos adds a repo and GET /repos returns it", async () => {
    const testPath = "/Users/test/mock-repo";
    const res1 = await request(app.handler as any)
      .post("/repos")
      .send({ repoPath: testPath });
    expect(res1.status).toBe(200);

    const res2 = await request(app.handler as any).get("/repos");
    expect(res2.status).toBe(200);
    expect(Array.isArray(res2.body)).toBe(true);
    expect(res2.body.includes(testPath)).toBe(true);

    // Cleanup
    await request(app.handler as any)
      .delete("/repos")
      .send({ repoPath: testPath });
  });

  it("POST /repos/watched enables watching and GET /repos/watched returns it", async () => {
    const testPath = "/Users/test/mock-repo-watched";
    const res1 = await request(app.handler as any)
      .post("/repos/watched")
      .send({ repoPath: testPath });
    expect(res1.status).toBe(200);

    const res2 = await request(app.handler as any).get("/repos/watched");
    expect(res2.status).toBe(200);
    expect(Array.isArray(res2.body)).toBe(true);
    expect(res2.body.includes(testPath)).toBe(true);

    // Cleanup
    await request(app.handler as any)
      .delete("/repos/watched")
      .send({ repoPath: testPath });
  });

  it("GET /workflows fails without repoPath", async () => {
    const res = await request(app.handler as any).get("/workflows");
    expect(res.status).toBe(400);
  });

  it("GET /disk-usage returns valid usage response", async () => {
    const res = await request(app.handler as any).get("/disk-usage");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("workspaces");
    expect(res.body.workspaces).toHaveProperty("count");
    expect(res.body.workspaces).toHaveProperty("items");
    expect(typeof res.body.totalBytes).toBe("number");
    expect(typeof res.body.pnpmStoreBytes).toBe("number");
    expect(typeof res.body.playwrightCacheBytes).toBe("number");
    expect(typeof res.body.logsBytes).toBe("number");
  }, 60_000); // getDiskUsage recursively scans pnpm-store / playwright-cache / logs which can be large
});

// ── Multi-job workflow fan-out ─────────────────────────────────────────────────

const MULTI_JOB_WORKFLOW = `
name: Multi Job Test
on: [push]
jobs:
  job-alpha:
    runs-on: ubuntu-latest
    steps:
      - run: echo alpha
  job-beta:
    runs-on: ubuntu-latest
    steps:
      - run: echo beta
`.trimStart();

describe("Multi-job workflow fan-out", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns one runner per job with shared base number and workflowRunId", async () => {
    // Set up a minimal fake repo with a two-job workflow
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = path.join(workflowsDir, "multi.yml");
    fs.writeFileSync(workflowFile, MULTI_JOB_WORKFLOW);

    // Run — child processes will fail quickly (no Docker/DTU) but metadata is
    // written synchronously before spawn so we can inspect it immediately.
    const runnerNames = await runWorkflow(tmpDir, "multi.yml", "WORKING_TREE");

    // Should have spawned exactly 2 runners (one per job)
    expect(runnerNames).toHaveLength(2);

    const [first, second] = runnerNames;

    // Both should share the same base number: oa-runner-N-001 / oa-runner-N-002
    expect(first).toMatch(/^oa-runner-\d+-001$/);
    expect(second).toMatch(/^oa-runner-\d+-002$/);

    // Base numbers must be identical
    const baseFirst = first.replace(/-\d{3}$/, "");
    const baseSecond = second.replace(/-\d{3}$/, "");
    expect(baseFirst).toBe(baseSecond);

    // Read the metadata files to verify grouping fields
    const { getLogsDir } = await import("../logger.js");
    const logsDir = getLogsDir();

    const meta1 = JSON.parse(fs.readFileSync(path.join(logsDir, first, "metadata.json"), "utf-8"));
    const meta2 = JSON.parse(fs.readFileSync(path.join(logsDir, second, "metadata.json"), "utf-8"));

    // workflowRunId is the shared base (oa-runner-N) for both jobs
    expect(meta1.workflowRunId).toBe(baseFirst);
    expect(meta2.workflowRunId).toBe(baseFirst);

    // workflowName is the bare workflow name (no job appended)
    expect(meta1.workflowName).toBe("multi");
    expect(meta2.workflowName).toBe("multi");

    // jobName is the individual job ID
    expect(meta1.jobName).toBe("job-alpha");
    expect(meta2.jobName).toBe("job-beta");
  });

  it("single-job workflow gets plain oa-runner-N name with null jobName", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = path.join(workflowsDir, "single.yml");
    fs.writeFileSync(
      workflowFile,
      `name: Single Job\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    const runnerNames = await runWorkflow(tmpDir, "single.yml", "WORKING_TREE");

    expect(runnerNames).toHaveLength(1);
    expect(runnerNames[0]).toMatch(/^oa-runner-\d+$/); // no -001 suffix

    const { getLogsDir } = await import("../logger.js");
    const logsDir = getLogsDir();
    const meta = JSON.parse(
      fs.readFileSync(path.join(logsDir, runnerNames[0], "metadata.json"), "utf-8"),
    );
    expect(meta.jobName).toBeNull();
    expect(meta.workflowRunId).toBe(runnerNames[0]); // self-referential for single-job
  });

  it("retryRun creates new runner with original workflowRunId and incremented attempt", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = path.join(workflowsDir, "retry-test.yml");
    fs.writeFileSync(
      workflowFile,
      `name: Retry Test\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    // Original run
    const runnerNames = await runWorkflow(tmpDir, "retry-test.yml", "abc123");
    expect(runnerNames).toHaveLength(1);
    const originalRunner = runnerNames[0];

    const { getLogsDir } = await import("../logger.js");
    const logsDir = getLogsDir();
    const originalMeta = JSON.parse(
      fs.readFileSync(path.join(logsDir, originalRunner, "metadata.json"), "utf-8"),
    );
    expect(originalMeta.attempt).toBe(1);
    expect(originalMeta.workflowRunId).toBe(originalRunner);

    // Retry
    const result = await retryRun(originalRunner);
    expect(result).not.toBeNull();
    // New naming: {originalRunId}-001 (attempt-1 padded to 3 digits)
    expect(result!.runnerName).toBe(`${originalRunner}-001`);
    expect(result!.attempt).toBe(2);

    const retryMeta = JSON.parse(
      fs.readFileSync(path.join(logsDir, result!.runnerName, "metadata.json"), "utf-8"),
    );
    // Same group as original
    expect(retryMeta.workflowRunId).toBe(originalMeta.workflowRunId);
    // Same commit and repo
    expect(retryMeta.commitId).toBe("abc123");
    expect(retryMeta.repoPath).toBe(tmpDir);
    // Incremented attempt
    expect(retryMeta.attempt).toBe(2);
    // Same taskId
    expect(retryMeta.taskId ?? null).toBe(originalMeta.taskId ?? null);
  });
});

// ── Matrix workflow fan-out ────────────────────────────────────────────────────

const MATRIX_WORKFLOW_3_SHARDS = `
name: Playwright Matrix
on: [push]
jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3]
    steps:
      - name: Run Playwright tests (Shard \${{ matrix.shard }}/\${{ strategy.job-total }})
        run: pnpm test:e2e:ci --shard=\${{ matrix.shard }}/\${{ strategy.job-total }}
`.trimStart();

describe("Matrix workflow fan-out", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns one runner per shard with correct matrixContext in metadata", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-matrix-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "matrix.yml"), MATRIX_WORKFLOW_3_SHARDS);

    const runnerNames = await runWorkflow(tmpDir, "matrix.yml", "WORKING_TREE");

    // 3 shards → 3 runners
    expect(runnerNames).toHaveLength(3);

    // All share the same base number, suffixed -001, -002, -003
    expect(runnerNames[0]).toMatch(/^oa-runner-\d+-001$/);
    expect(runnerNames[1]).toMatch(/^oa-runner-\d+-002$/);
    expect(runnerNames[2]).toMatch(/^oa-runner-\d+-003$/);

    const baseFirst = runnerNames[0].replace(/-\d{3}$/, "");
    const baseSecond = runnerNames[1].replace(/-\d{3}$/, "");
    const baseThird = runnerNames[2].replace(/-\d{3}$/, "");
    expect(baseFirst).toBe(baseSecond);
    expect(baseFirst).toBe(baseThird);

    const { getLogsDir } = await import("../logger.js");
    const logsDir = getLogsDir();

    const metas = await Promise.all(
      runnerNames.map((name) =>
        JSON.parse(fs.readFileSync(path.join(logsDir, name, "metadata.json"), "utf-8")),
      ),
    );

    // Each runner should record its shard in matrixContext
    expect(metas[0].matrixContext?.shard).toBe("1");
    expect(metas[1].matrixContext?.shard).toBe("2");
    expect(metas[2].matrixContext?.shard).toBe("3");

    // strategy.job-total should be 3 for all
    expect(metas[0].matrixContext?.__job_total).toBe("3");
    expect(metas[1].matrixContext?.__job_total).toBe("3");
    expect(metas[2].matrixContext?.__job_total).toBe("3");

    // All share the same workflowRunId
    expect(metas[0].workflowRunId).toBe(metas[1].workflowRunId);
    expect(metas[0].workflowRunId).toBe(metas[2].workflowRunId);

    // All have the same jobName (same job definition, different shards)
    expect(metas[0].jobName).toBe("e2e (1/3)");
    expect(metas[1].jobName).toBe("e2e (2/3)");
    expect(metas[2].jobName).toBe("e2e (3/3)");
  });

  it("single-job no-matrix workflow still gets a plain oa-runner-N name", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-matrix-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "simple.yml"),
      `name: Simple\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    const runnerNames = await runWorkflow(tmpDir, "simple.yml", "WORKING_TREE");

    expect(runnerNames).toHaveLength(1);
    expect(runnerNames[0]).toMatch(/^oa-runner-\d+$/); // no -001 suffix
  });
});
