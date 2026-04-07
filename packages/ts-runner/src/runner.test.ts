import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

import { runWorkflow } from "./runner.js";
import { parseWorkflowYaml } from "./workflow-parser.js";

describe("parseWorkflowYaml", () => {
  it("parses a simple workflow", () => {
    const wf = parseWorkflowYaml(`
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
      - run: echo world
`);
    expect(wf.name).toBe("CI");
    expect(wf.jobs).toHaveLength(1);
    expect(wf.jobs[0].id).toBe("test");
    expect(wf.jobs[0].steps).toHaveLength(2);
    expect(wf.jobs[0].steps[0].type).toBe("script");
  });

  it("parses job dependencies", () => {
    const wf = parseWorkflowYaml(`
name: CI
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: echo test
  deploy:
    needs: [build, test]
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`);
    expect(wf.jobs[0].needs).toEqual([]);
    expect(wf.jobs[1].needs).toEqual(["build"]);
    expect(wf.jobs[2].needs).toEqual(["build", "test"]);
  });

  it("parses matrix strategy", () => {
    const wf = parseWorkflowYaml(`
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
        os: [ubuntu, macos]
    steps:
      - run: echo test
`);
    expect(wf.jobs[0].matrix).toHaveLength(6);
    expect(wf.jobs[0].matrix![0]).toEqual({ node: "18", os: "ubuntu" });
    expect(wf.jobs[0].matrix![5]).toEqual({ node: "22", os: "macos" });
  });

  it("parses action steps", () => {
    const wf = parseWorkflowYaml(`
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm test
`);
    const steps = wf.jobs[0].steps;
    expect(steps[0].type).toBe("action");
    expect((steps[0] as any).uses).toBe("actions/checkout@v4");
    expect(steps[1].type).toBe("action");
    expect((steps[1] as any).with).toEqual({ "node-version": "20" });
    expect(steps[2].type).toBe("script");
  });

  it("parses step conditions", () => {
    const wf = parseWorkflowYaml(`
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo always
        if: always()
      - run: echo on-failure
        if: failure()
`);
    expect(wf.jobs[0].steps[0].if).toBe("always()");
    expect(wf.jobs[0].steps[1].if).toBe("failure()");
  });
});

describe("runWorkflow", () => {
  it("runs a simple echo workflow", async () => {
    // Create a temp workspace with a workflow file
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

    // Clean up
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
    // The setter step should have captured outputs
    expect(result.jobs[0].steps[0].outputs.version).toBe("1.2.3");
    expect(result.jobs[0].steps[0].outputs.name).toBe("my-app");
    // The reader step should have used the output via env interpolation
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
