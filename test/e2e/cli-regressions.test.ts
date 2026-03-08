import { describe, it, expect } from "vitest";
import { runCLI, PROJECT_ROOT } from "./setup.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SMOKE_WORKFLOW = ".github/workflows/smoke-tests.yml";
const CONTAINER_WORKFLOW = path.resolve(PROJECT_ROOT, "test/fixtures/container-test.yml");
const runsDir = path.join(os.tmpdir(), "machinen", path.basename(PROJECT_ROOT), "runs");

/**
 * Extract the runner name from CLI stdout.
 * Convention: `machinen-<slug>-<N>` (possibly with -j/-m suffixes).
 */
function extractRunnerName(stdout: string): string {
  const match = stdout.match(/machinen-\d+(?:-[jmr]\d+)*/);
  if (!match) {
    throw new Error(
      `[E2E] Could not extract runner name from stdout.\n--- stdout ---\n${stdout}\n---`,
    );
  }
  return match[0];
}

/**
 * Read output.log for a runner: .machinen/runs/<name>/logs/output.log
 */
function readOutputLog(runnerName: string): string {
  const logPath = path.join(runsDir, runnerName, "logs", "output.log");
  if (!fs.existsSync(logPath)) {
    const available = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).join(", ") : "(no runs dir)";
    throw new Error(`[E2E] Log not found: ${logPath}\n  Available: ${available}`);
  }
  return fs.readFileSync(logPath, "utf8");
}

describe("CLI E2E Regressions", () => {
  it("should run the smoke build job and exit correctly", async () => {
    const result = await runCLI(SMOKE_WORKFLOW);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed");

    const runnerName = extractRunnerName(result.stdout);
    const logs = readOutputLog(runnerName);
    expect(logs).toContain("Hello from E2E");
  }, 90000);

  it("should place logs in os.tmpdir()/machinen/<repo>/runs/<runner>/logs/output.log", async () => {
    const countRuns = () =>
      fs.existsSync(runsDir)
        ? fs
            .readdirSync(runsDir, { withFileTypes: true })
            .filter(
              (e) =>
                e.isDirectory() &&
                e.name.startsWith("machinen-") &&
                fs.existsSync(path.join(runsDir, e.name, "logs", "output.log")),
            ).length
        : 0;

    const before = countRuns();
    await runCLI(SMOKE_WORKFLOW);
    expect(countRuns()).toBeGreaterThan(before);
  }, 90000);

  it("should write and restore cache via actions/cache", async () => {
    const result = await runCLI(SMOKE_WORKFLOW);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed");

    const logs = readOutputLog(extractRunnerName(result.stdout));
    expect(logs).toContain("Hello from cache");
    expect(logs).toContain("Cache saved with key");
  }, 90000);

  it("should upload an artifact via actions/upload-artifact", async () => {
    const result = await runCLI(SMOKE_WORKFLOW);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed");

    const logs = readOutputLog(extractRunnerName(result.stdout));
    expect(logs).toContain("smoke-build has been successfully uploaded");
  }, 90000);

  it("should run job steps inside the specified container image", async () => {
    const result = await runCLI(CONTAINER_WORKFLOW);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("passed");

    const logs = readOutputLog(extractRunnerName(result.stdout));
    // Ubuntu 24.04 (noble) — confirms the container image was used, not the default runner
    expect(logs).toContain("noble");
  }, 120000);
});
