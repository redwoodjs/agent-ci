import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkflowTemplate } from "./workflow/workflow-parser.js";
import { getWorkflowJobsWithFallback } from "./workflow/job-fallback.js";

describe("getWorkflowJobsWithFallback", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to raw YAML jobs when parser output omits template.jobs", async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-cli-jobs-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "ci.yml");
    const runnerTempExpr = "${{ runner.temp }}";

    fs.writeFileSync(
      filePath,
      `name: Repro
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      HOME: ${runnerTempExpr}/home
    steps:
      - run: echo hi
`,
    );

    const template = await getWorkflowTemplate(filePath);
    expect(Array.isArray((template as any)?.jobs)).toBe(false);

    const jobs = getWorkflowJobsWithFallback(template, filePath);

    expect(jobs).toEqual([
      {
        type: "job",
        id: "test",
        name: "test",
      },
    ]);
  });
});
