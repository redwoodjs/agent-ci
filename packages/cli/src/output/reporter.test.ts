import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { printSummary, type JobResult } from "./reporter.js";

function makeResult(overrides: Partial<JobResult> = {}): JobResult {
  return {
    name: "container-1",
    workflow: "retry-proof.yml",
    taskId: "test",
    succeeded: false,
    durationMs: 1000,
    debugLogPath: "/tmp/debug.log",
    ...overrides,
  };
}

describe("printSummary", () => {
  let tmpDir: string;
  let output: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reporter-test-"));
    output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += chunk;
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("outputs full step log content when failedStepLogPath exists", () => {
    const logPath = path.join(tmpDir, "Run-assertion-test.log");
    fs.writeFileSync(logPath, "line 1\nline 2\nline 3\n");

    printSummary([
      makeResult({
        failedStep: "Run assertion test",
        failedStepLogPath: logPath,
        lastOutputLines: ["last line only"],
      }),
    ]);

    expect(output).toContain("line 1\nline 2\nline 3\n");
    expect(output).not.toContain("last line only");
    expect(output).not.toContain("Last output:");
    expect(output).not.toContain("Exit code:");
  });

  it("falls back to lastOutputLines when failedStepLogPath is absent", () => {
    printSummary([
      makeResult({
        failedStep: "Run assertion test",
        lastOutputLines: ["fallback line 1", "fallback line 2"],
      }),
    ]);

    expect(output).toContain("fallback line 1\nfallback line 2");
    expect(output).not.toContain("Last output:");
  });

  it("shows the failed step name in the FAILURES section", () => {
    const logPath = path.join(tmpDir, "step.log");
    fs.writeFileSync(logPath, "error output\n");

    printSummary([
      makeResult({
        failedStep: "Run assertion test",
        failedStepLogPath: logPath,
      }),
    ]);

    expect(output).toContain('✗ retry-proof.yml > test > "Run assertion test"');
  });

  it("deduplicates failures with identical error content", () => {
    printSummary([
      makeResult({
        taskId: "test (1)",
        failedStep: "[Job startup failed]",
        lastOutputLines: ["Missing secrets"],
      }),
      makeResult({
        taskId: "test (2)",
        failedStep: "[Job startup failed]",
        lastOutputLines: ["Missing secrets"],
      }),
      makeResult({
        taskId: "test (3)",
        failedStep: "[Job startup failed]",
        lastOutputLines: ["Missing secrets"],
      }),
    ]);

    // Error content should appear only once
    const matches = output.match(/Missing secrets/g);
    expect(matches).toHaveLength(1);

    // All job headers should still appear
    expect(output).toContain('test (1) > "[Job startup failed]"');
    expect(output).toContain('test (2) > "[Job startup failed]"');
    expect(output).toContain('test (3) > "[Job startup failed]"');

    // Summary should show correct count
    expect(output).toContain("3 failed");
  });

  it("keeps distinct errors separate", () => {
    printSummary([
      makeResult({
        taskId: "build",
        failedStep: "Compile",
        lastOutputLines: ["syntax error"],
      }),
      makeResult({
        taskId: "lint",
        failedStep: "ESLint",
        lastOutputLines: ["unused variable"],
      }),
    ]);

    expect(output).toContain("syntax error");
    expect(output).toContain("unused variable");
  });

  it("shows pass count in summary for a successful run", () => {
    printSummary([makeResult({ succeeded: true })]);

    expect(output).toContain("✓ 1 passed");
    expect(output).not.toContain("FAILURES");
  });
});

// ── Empty results behavior (CLI exit logic) ──────────────────────────────────
// The CLI treats empty results as failure. These tests verify the logic pattern
// used in cli.ts: `results.length === 0 || results.some(r => !r.succeeded)`

describe("empty results exit logic", () => {
  function shouldFail(results: JobResult[]): boolean {
    return results.length === 0 || results.some((r) => !r.succeeded);
  }

  function shouldPrintSummary(results: JobResult[]): boolean {
    return results.length > 0;
  }

  it("treats empty results as failure", () => {
    expect(shouldFail([])).toBe(true);
  });

  it("treats results with a failure as failure", () => {
    expect(shouldFail([makeResult({ succeeded: false })])).toBe(true);
  });

  it("treats all-passing results as success", () => {
    const passing: JobResult[] = [
      {
        name: "c1",
        workflow: "ci.yml",
        taskId: "test",
        succeeded: true,
        durationMs: 100,
        debugLogPath: "/tmp/x",
      },
    ];
    expect(shouldFail(passing)).toBe(false);
  });

  it("skips summary print for empty results", () => {
    expect(shouldPrintSummary([])).toBe(false);
  });

  it("prints summary for non-empty results", () => {
    expect(shouldPrintSummary([makeResult()])).toBe(true);
  });
});
