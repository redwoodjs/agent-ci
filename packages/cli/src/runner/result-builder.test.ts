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
