import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runWorkflow, retryRun, runWaveWithWarmSerialization } from "./runner.js";
import { setWorkingDirectory } from "../logger.js";

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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-test-"));
    setWorkingDirectory(tmpDir);
  });

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("spawns one runner per job with machinen- naming and shared workflowRunId", async () => {
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    const workflowFile = path.join(workflowsDir, "multi.yml");
    fs.writeFileSync(workflowFile, MULTI_JOB_WORKFLOW);

    // Also create a fake .git so repoSlug can be derived
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".git", "config"), "");

    // Run — child processes will fail quickly (no Docker/DTU) but metadata is
    // written synchronously before spawn so we can inspect it immediately.
    const runnerNames = await runWorkflow(tmpDir, "multi.yml", "WORKING_TREE");

    // Should have spawned exactly 2 runners (one per job)
    expect(runnerNames).toHaveLength(2);

    const [first, second] = runnerNames;

    // Both should use machinen- prefix with -j1 / -j2 suffix for multi-job
    expect(first).toMatch(/^machinen-.+-\d+-j1$/);
    expect(second).toMatch(/^machinen-.+-\d+-j2$/);

    // Read the metadata files to verify grouping fields
    const { getRunsDir } = await import("../logger.js");
    const runsDir = getRunsDir();

    const meta1 = JSON.parse(
      fs.readFileSync(path.join(runsDir, first, "logs", "metadata.json"), "utf-8"),
    );
    const meta2 = JSON.parse(
      fs.readFileSync(path.join(runsDir, second, "logs", "metadata.json"), "utf-8"),
    );

    // workflowRunId is the shared base (machinen-<slug>-N, no -jJ suffix) for both jobs
    expect(meta1.workflowRunId).toBe(meta2.workflowRunId);
    // workflowName is the bare workflow name
    expect(meta1.workflowName).toBe("multi");
    expect(meta2.workflowName).toBe("multi");
    // jobName is the individual job ID
    expect(meta1.jobName).toBe("job-alpha");
    expect(meta2.jobName).toBe("job-beta");
  });

  it("single-job workflow gets plain machinen-<slug>-N name with null jobName", async () => {
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "single.yml"),
      `name: Single Job\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    const runnerNames = await runWorkflow(tmpDir, "single.yml", "WORKING_TREE");

    expect(runnerNames).toHaveLength(1);
    // Single-job: no -jJ suffix
    expect(runnerNames[0]).toMatch(/^machinen-.+-\d+$/);
    expect(runnerNames[0]).not.toMatch(/-j\d+$/); // no multi-job suffix

    const { getRunsDir } = await import("../logger.js");
    const runsDir = getRunsDir();
    const meta = JSON.parse(
      fs.readFileSync(path.join(runsDir, runnerNames[0], "logs", "metadata.json"), "utf-8"),
    );
    expect(meta.jobName).toBeNull();
    expect(meta.workflowRunId).toBe(runnerNames[0]); // self-referential for single-job
  });

  it("retryRun creates new runner with -r<N> suffix and incremented attempt", async () => {
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "retry-test.yml"),
      `name: Retry Test\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    // Original run
    const runnerNames = await runWorkflow(tmpDir, "retry-test.yml", "abc123");
    expect(runnerNames).toHaveLength(1);
    const originalRunner = runnerNames[0];

    const { getRunsDir } = await import("../logger.js");
    const runsDir = getRunsDir();
    const originalMeta = JSON.parse(
      fs.readFileSync(path.join(runsDir, originalRunner, "logs", "metadata.json"), "utf-8"),
    );
    expect(originalMeta.attempt).toBe(1);
    expect(originalMeta.workflowRunId).toBe(originalRunner);

    // Retry
    const result = await retryRun(originalRunner);
    expect(result).not.toBeNull();
    // New naming: {originalRunId}-r2
    expect(result!.runnerName).toBe(`${originalRunner}-r2`);
    expect(result!.attempt).toBe(2);

    const retryMeta = JSON.parse(
      fs.readFileSync(path.join(runsDir, result!.runnerName, "logs", "metadata.json"), "utf-8"),
    );
    expect(retryMeta.workflowRunId).toBe(originalMeta.workflowRunId);
    expect(retryMeta.commitId).toBe("abc123");
    expect(retryMeta.repoPath).toBe(tmpDir);
    expect(retryMeta.attempt).toBe(2);
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-matrix-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(workflowsDir, "matrix.yml"), MATRIX_WORKFLOW_3_SHARDS);

    const runnerNames = await runWorkflow(tmpDir, "matrix.yml", "WORKING_TREE");

    // 3 shards → 3 runners (single-job with matrix: no -j suffix but -m1,-m2,-m3)
    expect(runnerNames).toHaveLength(3);
    expect(runnerNames[0]).toMatch(/^machinen-.+-\d+-m1$/);
    expect(runnerNames[1]).toMatch(/^machinen-.+-\d+-m2$/);
    expect(runnerNames[2]).toMatch(/^machinen-.+-\d+-m3$/);

    const { getRunsDir } = await import("../logger.js");
    const runsDir = getRunsDir();

    const metas = runnerNames.map((name) =>
      JSON.parse(fs.readFileSync(path.join(runsDir, name, "logs", "metadata.json"), "utf-8")),
    );

    expect(metas[0].matrixContext?.shard).toBe("1");
    expect(metas[1].matrixContext?.shard).toBe("2");
    expect(metas[2].matrixContext?.shard).toBe("3");

    expect(metas[0].matrixContext?.__job_total).toBe("3");
    expect(metas[1].matrixContext?.__job_total).toBe("3");
    expect(metas[2].matrixContext?.__job_total).toBe("3");

    // All share the same workflowRunId
    expect(metas[0].workflowRunId).toBe(metas[1].workflowRunId);
    expect(metas[0].workflowRunId).toBe(metas[2].workflowRunId);

    expect(metas[0].jobName).toBe("e2e (1/3)");
    expect(metas[1].jobName).toBe("e2e (2/3)");
    expect(metas[2].jobName).toBe("e2e (3/3)");
  });

  it("single-job no-matrix workflow gets a plain machinen-<slug>-N name", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-matrix-test-"));
    const workflowsDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowsDir, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(
      path.join(workflowsDir, "simple.yml"),
      `name: Simple\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    );

    const runnerNames = await runWorkflow(tmpDir, "simple.yml", "WORKING_TREE");

    expect(runnerNames).toHaveLength(1);
    expect(runnerNames[0]).toMatch(/^machinen-.+-\d+$/);
    expect(runnerNames[0]).not.toMatch(/-j\d+|-m\d+/); // no suffixes
  });
});

// ── runWaveWithWarmSerialization ───────────────────────────────────────────────
//
// Tests the pure launch-plan function directly by injecting a spy spawner.

type FakeJob = { runnerName: string };

function makeSpySpawner(delayMs = 20) {
  const startLog: string[] = [];
  const endLog: string[] = [];
  const spawner = async (job: FakeJob): Promise<number> => {
    startLog.push(job.runnerName);
    await new Promise((r) => setTimeout(r, delayMs));
    endLog.push(job.runnerName);
    return 0;
  };
  return { startLog, endLog, spawner };
}

describe("runWaveWithWarmSerialization", () => {
  it("cold + multi-job: first job starts AND finishes before the rest start", async () => {
    const { startLog, endLog, spawner } = makeSpySpawner(30);
    const jobs: FakeJob[] = [
      { runnerName: "job-a" },
      { runnerName: "job-b" },
      { runnerName: "job-c" },
    ];

    await runWaveWithWarmSerialization(jobs, /* warm= */ false, spawner);

    expect(startLog[0]).toBe("job-a");
    expect(endLog[0]).toBe("job-a");
    const bStartIdx = startLog.indexOf("job-b");
    const cStartIdx = startLog.indexOf("job-c");
    expect(bStartIdx).toBeGreaterThan(0);
    expect(cStartIdx).toBeGreaterThan(0);
    expect(startLog).toHaveLength(3);
    expect(endLog).toHaveLength(3);
  });

  it("cold + multi-job: remaining jobs run concurrently (not sequentially)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawner = async (_job: FakeJob): Promise<number> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 30));
      concurrent--;
      return 0;
    };
    const jobs: FakeJob[] = [
      { runnerName: "job-a" },
      { runnerName: "job-b" },
      { runnerName: "job-c" },
    ];

    await runWaveWithWarmSerialization(jobs, /* warm= */ false, spawner);
    expect(maxConcurrent).toBe(2);
  });

  it("warm: all jobs start concurrently (max concurrent = job count)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawner = async (_job: FakeJob): Promise<number> => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return 0;
    };
    const jobs: FakeJob[] = [
      { runnerName: "job-a" },
      { runnerName: "job-b" },
      { runnerName: "job-c" },
    ];

    await runWaveWithWarmSerialization(jobs, /* warm= */ true, spawner);
    expect(maxConcurrent).toBe(3);
  });

  it("single job never serializes (cold or warm)", async () => {
    const { startLog, endLog, spawner } = makeSpySpawner(10);
    const jobs: FakeJob[] = [{ runnerName: "only-job" }];

    const results = await runWaveWithWarmSerialization(jobs, /* warm= */ false, spawner);

    expect(results).toEqual([0]);
    expect(startLog).toEqual(["only-job"]);
    expect(endLog).toEqual(["only-job"]);
  });

  it("preserves result order regardless of completion order", async () => {
    const jobs: FakeJob[] = [
      { runnerName: "job-a" },
      { runnerName: "job-b" },
      { runnerName: "job-c" },
    ];

    const coldResults = await runWaveWithWarmSerialization(jobs, false, async (j) =>
      jobs.indexOf(j),
    );
    expect(coldResults).toEqual([0, 1, 2]);

    const warmResults = await runWaveWithWarmSerialization(jobs, true, async (j) =>
      jobs.indexOf(j),
    );
    expect(warmResults).toEqual([0, 1, 2]);
  });

  it("integration: multi-job workflow returns all runner names on cold path", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-warm-flow-test-"));
    try {
      const workflowsDir = path.join(tmpDir, ".github", "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      const content =
        [
          "name: Parallel Jobs",
          "on: [push]",
          "jobs:",
          "  job-a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo a",
          "  job-b:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo b",
        ].join("\n") + "\n";
      fs.writeFileSync(path.join(workflowsDir, "parallel.yml"), content);

      const runnerNames = await runWorkflow(tmpDir, "parallel.yml", "WORKING_TREE");

      expect(runnerNames).toHaveLength(2);
      expect(runnerNames[0]).toMatch(/^machinen-.+-\d+-j1$/);
      expect(runnerNames[1]).toMatch(/^machinen-.+-\d+-j2$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("integration: cold path tags first job as cold and remaining as warm", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-warm-tag-test-"));
    try {
      const workflowsDir = path.join(tmpDir, ".github", "workflows");
      fs.mkdirSync(workflowsDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      const content =
        [
          "name: Three Jobs",
          "on: [push]",
          "jobs:",
          "  job-a:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo a",
          "  job-b:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo b",
          "  job-c:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - run: echo c",
        ].join("\n") + "\n";
      fs.writeFileSync(path.join(workflowsDir, "three.yml"), content);

      const runnerNames = await runWorkflow(tmpDir, "three.yml", "WORKING_TREE");
      expect(runnerNames).toHaveLength(3);

      const { getRunsDir } = await import("../logger.js");
      const runsDir = getRunsDir();
      const metas = runnerNames.map((name) =>
        JSON.parse(fs.readFileSync(path.join(runsDir, name, "logs", "metadata.json"), "utf-8")),
      );

      // First job: cold install (it does pnpm install to warm the cache)
      expect(metas[0].warmCache).toBe(false);
      // Remaining jobs: warm (they reuse node_modules populated by the first)
      expect(metas[1].warmCache).toBe(true);
      expect(metas[2].warmCache).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
