import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── parseTimelineSteps ────────────────────────────────────────────────────────

describe("parseTimelineSteps", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "result-builder-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses succeeded, failed, and skipped steps", async () => {
    const { parseTimelineSteps } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        { type: "Task", name: "Setup", result: "Succeeded" },
        { type: "Task", name: "Build", result: "Failed" },
        { type: "Task", name: "Deploy", result: "Skipped" },
        { type: "Task", name: "Cleanup", state: "completed" },
      ]),
    );

    const steps = parseTimelineSteps(timelinePath);
    expect(steps).toEqual([
      { name: "Setup", status: "passed" },
      { name: "Build", status: "failed" },
      { name: "Deploy", status: "skipped" },
      { name: "Cleanup", status: "passed" },
    ]);
  });

  it("returns empty array when file does not exist", async () => {
    const { parseTimelineSteps } = await import("./result-builder.js");
    expect(parseTimelineSteps(path.join(tmpDir, "nope.json"))).toEqual([]);
  });

  it("filters out non-Task records", async () => {
    const { parseTimelineSteps } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        { type: "Job", name: "Root" },
        { type: "Task", name: "Build", result: "succeeded" },
      ]),
    );

    const steps = parseTimelineSteps(timelinePath);
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("Build");
  });

  it("attaches per-step logPath when logDir is given and the file exists", async () => {
    const { parseTimelineSteps } = await import("./result-builder.js");
    const stepsDir = path.join(tmpDir, "steps");
    fs.mkdirSync(stepsDir, { recursive: true });
    // Sanitized name match
    fs.writeFileSync(path.join(stepsDir, "Run-tests.log"), "a");
    // Record-id fallback
    fs.writeFileSync(path.join(stepsDir, "uuid-build.log"), "b");

    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        { type: "Task", name: "Run tests", result: "Succeeded" },
        { type: "Task", name: "Build", result: "Failed", id: "uuid-build" },
        { type: "Task", name: "Deploy", result: "Skipped" },
      ]),
    );

    const steps = parseTimelineSteps(timelinePath, tmpDir);
    expect(steps[0].logPath).toBe(path.join(stepsDir, "Run-tests.log"));
    expect(steps[1].logPath).toBe(path.join(stepsDir, "uuid-build.log"));
    expect(steps[2].logPath).toBeUndefined();
  });

  it("leaves logPath undefined when logDir is omitted", async () => {
    const { parseTimelineSteps } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([{ type: "Task", name: "Build", result: "Succeeded" }]),
    );
    const steps = parseTimelineSteps(timelinePath);
    expect(steps[0].logPath).toBeUndefined();
  });
});

// ── sanitizeStepName ──────────────────────────────────────────────────────────

describe("sanitizeStepName", () => {
  it("replaces special characters with hyphens", async () => {
    const { sanitizeStepName } = await import("./result-builder.js");
    expect(sanitizeStepName("Run npm test (shard 1/3)")).toBe("Run-npm-test-shard-1-3");
  });

  it("collapses multiple hyphens", async () => {
    const { sanitizeStepName } = await import("./result-builder.js");
    expect(sanitizeStepName("a   b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing hyphens", async () => {
    const { sanitizeStepName } = await import("./result-builder.js");
    expect(sanitizeStepName("--test--")).toBe("test");
  });

  it("truncates to 80 characters", async () => {
    const { sanitizeStepName } = await import("./result-builder.js");
    const long = "a".repeat(100);
    expect(sanitizeStepName(long).length).toBe(80);
  });
});

// ── extractFailureDetails ─────────────────────────────────────────────────────

describe("extractFailureDetails", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "failure-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts exit code from the issues array", async () => {
    const { extractFailureDetails } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        {
          type: "Task",
          name: "Build",
          result: "Failed",
          issues: [{ type: "error", message: "Process completed with exit code 2" }],
        },
      ]),
    );

    const details = extractFailureDetails(timelinePath, "Build", tmpDir);
    expect(details.exitCode).toBe(2);
  });

  it("finds the step log file via sanitized name", async () => {
    const { extractFailureDetails } = await import("./result-builder.js");
    const stepsDir = path.join(tmpDir, "steps");
    fs.mkdirSync(stepsDir, { recursive: true });
    fs.writeFileSync(path.join(stepsDir, "Run-tests.log"), "error line 1\nerror line 2\n");

    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        {
          type: "Task",
          name: "Run tests",
          result: "Failed",
          id: "uuid-123",
        },
      ]),
    );

    const details = extractFailureDetails(timelinePath, "Run tests", tmpDir);
    expect(details.stepLogPath).toBe(path.join(stepsDir, "Run-tests.log"));
    expect(details.tailLines).toContain("error line 1");
  });

  it("returns empty object when no matching record exists", async () => {
    const { extractFailureDetails } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(timelinePath, JSON.stringify([]));

    const details = extractFailureDetails(timelinePath, "NonExistent", tmpDir);
    expect(details).toEqual({});
  });
});

// ── isJobSuccessful ──────────────────────────────────────────────────────────

describe("isJobSuccessful", () => {
  it("succeeds when no failed step, exit code 0, and not booting", async () => {
    const { isJobSuccessful } = await import("./result-builder.js");
    expect(isJobSuccessful({ lastFailedStep: null, containerExitCode: 0, isBooting: false })).toBe(
      true,
    );
  });

  it("fails when a step failed", async () => {
    const { isJobSuccessful } = await import("./result-builder.js");
    expect(
      isJobSuccessful({ lastFailedStep: "Build", containerExitCode: 0, isBooting: false }),
    ).toBe(false);
  });

  it("fails when container exit code is non-zero", async () => {
    const { isJobSuccessful } = await import("./result-builder.js");
    expect(isJobSuccessful({ lastFailedStep: null, containerExitCode: 1, isBooting: false })).toBe(
      false,
    );
  });

  it("fails when runner never contacted DTU (isBooting=true)", async () => {
    const { isJobSuccessful } = await import("./result-builder.js");
    // This is the bug from #102: container exits 0 with no failed steps,
    // but the runner never sent any timeline entries (isBooting stayed true).
    expect(isJobSuccessful({ lastFailedStep: null, containerExitCode: 0, isBooting: true })).toBe(
      false,
    );
  });
});

// ── buildJobResult ────────────────────────────────────────────────────────────

describe("buildJobResult", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "result-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("builds a successful result", async () => {
    const { buildJobResult } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([{ type: "Task", name: "Build", result: "Succeeded" }]),
    );

    const result = buildJobResult({
      containerName: "test-runner",
      job: { workflowPath: "/tmp/ci.yml", taskId: "build" },
      startTime: Date.now() - 5000,
      jobSucceeded: true,
      lastFailedStep: null,
      containerExitCode: 0,
      timelinePath,
      logDir: tmpDir,
      debugLogPath: path.join(tmpDir, "debug.log"),
    });

    expect(result.succeeded).toBe(true);
    expect(result.name).toBe("test-runner");
    expect(result.workflow).toBe("ci.yml");
    expect(result.steps).toHaveLength(1);
    expect(result.failedStep).toBeUndefined();
  });

  it("builds a failed result with failure details", async () => {
    const { buildJobResult } = await import("./result-builder.js");
    const timelinePath = path.join(tmpDir, "timeline.json");
    const stepsDir = path.join(tmpDir, "steps");
    fs.mkdirSync(stepsDir, { recursive: true });
    fs.writeFileSync(path.join(stepsDir, "Build.log"), "compile error\nfailed\n");
    fs.writeFileSync(
      timelinePath,
      JSON.stringify([
        {
          type: "Task",
          name: "Build",
          result: "Failed",
          issues: [{ type: "error", message: "Process completed with exit code 1" }],
        },
      ]),
    );

    const result = buildJobResult({
      containerName: "test-runner",
      job: { workflowPath: "/tmp/ci.yml", taskId: "build" },
      startTime: Date.now() - 5000,
      jobSucceeded: false,
      lastFailedStep: "Build",
      containerExitCode: 0,
      timelinePath,
      logDir: tmpDir,
      debugLogPath: path.join(tmpDir, "debug.log"),
    });

    expect(result.succeeded).toBe(false);
    expect(result.failedStep).toBe("Build");
    expect(result.failedExitCode).toBe(1);
    expect(result.failedStepLogPath).toBe(path.join(stepsDir, "Build.log"));
    expect(result.lastOutputLines).toContain("compile error");
  });
});

// ── extractStepOutputs ────────────────────────────────────────────────────────

describe("extractStepOutputs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-outputs-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts simple key=value outputs from set_output files", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    // Simulate the runner's file_commands directory structure
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(fileCommandsDir, "set_output_abc123"),
      "skip=false\nshard_count=3\n",
    );

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs).toEqual({
      skip: "false",
      shard_count: "3",
    });
  });

  it("extracts multiline (heredoc) values", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(fileCommandsDir, "set_output_def456"),
      'matrix<<EOF\n["1","2","3"]\nEOF\n',
    );

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs).toEqual({
      matrix: '["1","2","3"]',
    });
  });

  it("merges outputs from multiple set_output files", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(path.join(fileCommandsDir, "set_output_aaa"), "key1=val1\n");
    fs.writeFileSync(path.join(fileCommandsDir, "set_output_bbb"), "key2=val2\n");

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs.key1).toBe("val1");
    expect(outputs.key2).toBe("val2");
  });

  it("returns empty object when no _runner_file_commands directory exists", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const outputs = extractStepOutputs(tmpDir);
    expect(outputs).toEqual({});
  });

  it("returns empty object when directory has no set_output files", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(path.join(fileCommandsDir, "add_path_xyz"), "/usr/local/bin\n");

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs).toEqual({});
  });

  it("later files override earlier ones for the same key", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(path.join(fileCommandsDir, "set_output_aaa"), "key=first\n");
    fs.writeFileSync(path.join(fileCommandsDir, "set_output_zzz"), "key=second\n");

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs.key).toBe("second");
  });

  it("handles multiline heredoc with multiple lines", async () => {
    const { extractStepOutputs } = await import("./result-builder.js");
    const fileCommandsDir = path.join(tmpDir, "_runner_file_commands");
    fs.mkdirSync(fileCommandsDir, { recursive: true });
    fs.writeFileSync(
      path.join(fileCommandsDir, "set_output_multi"),
      "tests<<DELIM\ntest1.ts\ntest2.ts\ntest3.ts\nDELIM\n",
    );

    const outputs = extractStepOutputs(tmpDir);
    expect(outputs.tests).toBe("test1.ts\ntest2.ts\ntest3.ts");
  });
});

// ── resolveJobOutputs ─────────────────────────────────────────────────────────

describe("resolveJobOutputs", () => {
  it("resolves step output references in job output templates", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const outputDefs = {
      skip: "${{ steps.check.outputs.skip }}",
      count: "${{ steps.counter.outputs.shard_count }}",
    };
    const stepOutputs = {
      skip: "false",
      shard_count: "3",
    };

    const resolved = resolveJobOutputs(outputDefs, stepOutputs);
    expect(resolved).toEqual({
      skip: "false",
      count: "3",
    });
  });

  it("returns empty string for unresolved step outputs", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const outputDefs = {
      missing: "${{ steps.none.outputs.doesnt_exist }}",
    };
    const stepOutputs = {};

    const resolved = resolveJobOutputs(outputDefs, stepOutputs);
    expect(resolved).toEqual({ missing: "" });
  });

  it("passes through literal values unchanged", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const outputDefs = {
      version: "1.2.3",
    };
    const stepOutputs = {};

    const resolved = resolveJobOutputs(outputDefs, stepOutputs);
    expect(resolved).toEqual({ version: "1.2.3" });
  });

  it("returns empty object when no output definitions", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const resolved = resolveJobOutputs({}, { some: "output" });
    expect(resolved).toEqual({});
  });

  it("handles JSON values in step outputs", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const outputDefs = {
      matrix: "${{ steps.plan.outputs.matrix }}",
    };
    const stepOutputs = {
      matrix: '{"shard":[1,2,3]}',
    };

    const resolved = resolveJobOutputs(outputDefs, stepOutputs);
    expect(resolved).toEqual({
      matrix: '{"shard":[1,2,3]}',
    });
  });

  it("handles templates with surrounding text", async () => {
    const { resolveJobOutputs } = await import("./result-builder.js");
    const outputDefs = {
      label: "shard-${{ steps.plan.outputs.index }}",
    };
    const stepOutputs = {
      index: "5",
    };

    const resolved = resolveJobOutputs(outputDefs, stepOutputs);
    expect(resolved).toEqual({ label: "shard-5" });
  });
});
