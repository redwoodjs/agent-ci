import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { runWorkflow } from "./runner.js";

describe("runWorkflow", () => {
  it("runs a simple echo workflow", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-test-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "test.yml"),
      `
name: Test
on: push
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - name: Say hello
        run: echo "Hello from ts-runner"
      - name: Set output
        run: echo "result=pass" >> "$GITHUB_OUTPUT"
`,
    );

    const output: string[] = [];
    const result = await runWorkflow({
      workflowPath: path.join(workflowDir, "test.yml"),
      workspace: tmpDir,
      onOutput: (line) => output.push(line),
    });

    expect(result.status).toBe("success");
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].status).toBe("success");
    expect(result.jobs[0].steps).toHaveLength(2);
    expect(result.jobs[0].steps[0].outcome).toBe("success");
    expect(output.some((l) => l.includes("Hello from ts-runner"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("captures GITHUB_OUTPUT values", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-test-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "outputs.yml"),
      `
name: Outputs
on: push
jobs:
  produce:
    runs-on: ubuntu-latest
    steps:
      - name: Set output
        id: setter
        run: |
          echo "version=1.2.3" >> "$GITHUB_OUTPUT"
          echo "name=my-app" >> "$GITHUB_OUTPUT"
      - name: Read output
        run: echo "Got version $VERSION"
        env:
          VERSION: \${{ steps.setter.outputs.version }}
`,
    );

    const output: string[] = [];
    const result = await runWorkflow({
      workflowPath: path.join(workflowDir, "outputs.yml"),
      workspace: tmpDir,
      onOutput: (line) => output.push(line),
    });

    expect(result.status).toBe("success");
    expect(result.jobs[0].steps[0].outputs.version).toBe("1.2.3");
    expect(result.jobs[0].steps[0].outputs.name).toBe("my-app");
    expect(output.some((l) => l.includes("Got version 1.2.3"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles step failure", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-test-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "fail.yml"),
      `
name: Fail
on: push
jobs:
  failing:
    runs-on: ubuntu-latest
    steps:
      - name: This succeeds
        run: echo ok
      - name: This fails
        run: exit 1
      - name: This runs on failure
        if: failure()
        run: echo "cleaning up"
      - name: This is skipped
        run: echo "should not run"
`,
    );

    const output: string[] = [];
    const result = await runWorkflow({
      workflowPath: path.join(workflowDir, "fail.yml"),
      workspace: tmpDir,
      onOutput: (line) => output.push(line),
    });

    expect(result.status).toBe("failure");
    expect(result.jobs[0].steps[0].outcome).toBe("success");
    expect(result.jobs[0].steps[1].outcome).toBe("failure");
    expect(result.jobs[0].steps[2].outcome).toBe("success"); // runs because if: failure()
    expect(result.jobs[0].steps[3].outcome).toBe("skipped"); // default condition is success()
    expect(output.some((l) => l.includes("cleaning up"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles GITHUB_ENV for cross-step env propagation", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-test-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "env.yml"),
      `
name: Env
on: push
jobs:
  env-test:
    runs-on: ubuntu-latest
    steps:
      - name: Set env
        run: echo "MY_VAR=hello-from-env" >> "$GITHUB_ENV"
      - name: Read env
        run: echo "MY_VAR is $MY_VAR"
`,
    );

    const output: string[] = [];
    const result = await runWorkflow({
      workflowPath: path.join(workflowDir, "env.yml"),
      workspace: tmpDir,
      onOutput: (line) => output.push(line),
    });

    expect(result.status).toBe("success");
    expect(output.some((l) => l.includes("MY_VAR is hello-from-env"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true });
  });

  it("handles job dependencies", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ts-runner-test-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    fs.writeFileSync(
      path.join(workflowDir, "deps.yml"),
      `
name: Deps
on: push
jobs:
  first:
    runs-on: ubuntu-latest
    steps:
      - run: echo "first job"
  second:
    needs: first
    runs-on: ubuntu-latest
    steps:
      - run: echo "second job"
`,
    );

    const jobOrder: string[] = [];
    const result = await runWorkflow({
      workflowPath: path.join(workflowDir, "deps.yml"),
      workspace: tmpDir,
      onJobStart: (job) => jobOrder.push(job.id),
    });

    expect(result.status).toBe("success");
    expect(jobOrder).toEqual(["first", "second"]);

    fs.rmSync(tmpDir, { recursive: true });
  });
});
