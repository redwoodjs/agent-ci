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

  it("shows pass count in summary for a successful run", () => {
    printSummary([makeResult({ succeeded: true })]);

    expect(output).toContain("✓ 1 passed");
    expect(output).not.toContain("FAILURES");
  });

  it("strips ansi escape codes from failure logs", () => {
    const logPath = path.join(tmpDir, "ansi.log");
    const esc = String.fromCharCode(27);
    const ansiText = `${esc}[31mexpect${esc}[39m(value).${esc}[34mtoBe${esc}[39m('pass')\n`;
    fs.writeFileSync(logPath, ansiText);

    printSummary([
      makeResult({
        failedStep: "Run assertion test",
        failedStepLogPath: logPath,
      }),
    ]);

    expect(output).toContain("expect(value).toBe('pass')");
    expect(output).not.toContain("\u001b[31m");
  });
});
