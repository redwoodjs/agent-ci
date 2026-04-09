import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expandReusableJobs } from "./reusable-workflow.js";

describe("expandReusableJobs", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "reusable-wf-test-"));
    // Create .github/workflows structure
    const wfDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(wfDir, { recursive: true });
    // Create a fake .git so resolveRepoRoot can find it
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    return wfDir;
  }

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns regular jobs unchanged when no reusable calls", () => {
    const wfDir = setup();
    const wf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      wf,
      `
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
`,
    );

    const entries = expandReusableJobs(wf, tmpDir);
    expect(entries).toEqual([
      { id: "build", workflowPath: wf, sourceTaskName: "build", needs: [] },
      { id: "test", workflowPath: wf, sourceTaskName: "test", needs: ["build"] },
    ]);
  });

  it("expands a simple reusable workflow call (one caller → one called job)", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "lint.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  lint:
    uses: ./.github/workflows/lint.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "lint/lint",
      workflowPath: calledWf,
      sourceTaskName: "lint",
      needs: [],
      callerJobId: "lint",
    });
  });

  it("expands multi-job called workflow with internal needs graph", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "test.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: echo setup
  unit:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: echo unit
  integration:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: echo integration
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  test:
    uses: ./.github/workflows/test.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(3);

    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    // setup is entry-point — inherits caller's needs (none)
    expect(byId["test/setup"].needs).toEqual([]);
    // unit and integration depend on setup (prefixed)
    expect(byId["test/unit"].needs).toEqual(["test/setup"]);
    expect(byId["test/integration"].needs).toEqual(["test/setup"]);
    // All point to the called workflow
    expect(byId["test/setup"].workflowPath).toBe(calledWf);
    expect(byId["test/unit"].sourceTaskName).toBe("unit");
  });

  it("rewires downstream deps to terminal jobs of inlined sub-graph", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "lint.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: echo setup
  check:
    needs: setup
    runs-on: ubuntu-latest
    steps:
      - run: echo check
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  lint:
    uses: ./.github/workflows/lint.yml
  deploy:
    needs: lint
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    const deploy = entries.find((e) => e.id === "deploy");
    // deploy should depend on the terminal job of the lint sub-graph
    expect(deploy!.needs).toEqual(["lint/check"]);
  });

  it("handles mixed regular + reusable jobs", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "lint.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    uses: ./.github/workflows/lint.yml
  test:
    needs: [build, lint]
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(3);

    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId["build"].workflowPath).toBe(callerWf);
    expect(byId["lint/lint"].workflowPath).toBe(calledWf);
    // test depends on build (regular) and lint/lint (terminal of inlined sub-graph)
    expect(byId["test"].needs).toEqual(["build", "lint/lint"]);
  });

  it("throws on unresolved remote uses refs", () => {
    const wfDir = setup();
    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    uses: some-org/some-repo/.github/workflows/lint.yml@main
`,
    );

    expect(() => expandReusableJobs(callerWf, tmpDir)).toThrow(
      /Remote reusable workflow not resolved/,
    );
  });

  it("expands remote uses refs when remoteCache is provided", () => {
    const wfDir = setup();

    // Create a file to act as the cached remote workflow
    const cachedWf = path.join(wfDir, "cached-remote-lint.yml");
    fs.writeFileSync(
      cachedWf,
      `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    uses: some-org/some-repo/.github/workflows/lint.yml@main
`,
    );

    const remoteCache = new Map<string, string>();
    remoteCache.set("some-org/some-repo/.github/workflows/lint.yml@main", cachedWf);

    const entries = expandReusableJobs(callerWf, tmpDir, remoteCache);
    expect(entries).toHaveLength(2);

    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId["build"].workflowPath).toBe(callerWf);
    expect(byId["lint/lint"].workflowPath).toBe(cachedWf);
    expect(byId["lint/lint"].sourceTaskName).toBe("lint");
  });

  it("expands 2-level nested reusable workflows", () => {
    const wfDir = setup();
    const leafWf = path.join(wfDir, "leaf.yml");
    fs.writeFileSync(
      leafWf,
      `
on: workflow_call
jobs:
  job:
    runs-on: ubuntu-latest
    steps:
      - run: echo leaf
`,
    );

    const innerWf = path.join(wfDir, "inner.yml");
    fs.writeFileSync(
      innerWf,
      `
on: workflow_call
jobs:
  nested:
    uses: ./.github/workflows/leaf.yml
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  outer:
    uses: ./.github/workflows/inner.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "outer/nested/job",
      workflowPath: leafWf,
      sourceTaskName: "job",
      needs: [],
    });
  });

  it("expands 2-level nested workflows with internal needs and downstream deps", () => {
    const wfDir = setup();
    const leafWf = path.join(wfDir, "b.yml");
    fs.writeFileSync(
      leafWf,
      `
on: workflow_call
jobs:
  leaf:
    runs-on: ubuntu-latest
    steps:
      - run: echo leaf
`,
    );

    const midWf = path.join(wfDir, "a.yml");
    fs.writeFileSync(
      midWf,
      `
on: workflow_call
jobs:
  inner:
    uses: ./.github/workflows/b.yml
  post:
    needs: inner
    runs-on: ubuntu-latest
    steps:
      - run: echo post
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  outer:
    uses: ./.github/workflows/a.yml
  deploy:
    needs: outer
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

    expect(byId["outer/inner/leaf"].needs).toEqual([]);
    expect(byId["outer/post"].needs).toEqual(["outer/inner/leaf"]);
    expect(byId["deploy"].needs).toEqual(["outer/post"]);
  });

  it("expands 3-level nested reusable workflows with chained composite IDs", () => {
    const wfDir = setup();
    const l3 = path.join(wfDir, "l3.yml");
    fs.writeFileSync(
      l3,
      `
on: workflow_call
jobs:
  leaf:
    runs-on: ubuntu-latest
    steps:
      - run: echo leaf
`,
    );

    const l2 = path.join(wfDir, "l2.yml");
    fs.writeFileSync(
      l2,
      `
on: workflow_call
jobs:
  l3:
    uses: ./.github/workflows/l3.yml
`,
    );

    const l1 = path.join(wfDir, "l1.yml");
    fs.writeFileSync(
      l1,
      `
on: workflow_call
jobs:
  l2:
    uses: ./.github/workflows/l2.yml
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  l1:
    uses: ./.github/workflows/l1.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "l1/l2/l3/leaf",
      workflowPath: l3,
      sourceTaskName: "leaf",
      needs: [],
    });
  });

  it("expands 4-level nested reusable workflows (GitHub max depth)", () => {
    const wfDir = setup();
    const l4 = path.join(wfDir, "l4.yml");
    fs.writeFileSync(
      l4,
      `
on: workflow_call
jobs:
  leaf:
    runs-on: ubuntu-latest
    steps:
      - run: echo leaf
`,
    );

    const l3 = path.join(wfDir, "l3.yml");
    fs.writeFileSync(
      l3,
      `
on: workflow_call
jobs:
  l4:
    uses: ./.github/workflows/l4.yml
`,
    );

    const l2 = path.join(wfDir, "l2.yml");
    fs.writeFileSync(
      l2,
      `
on: workflow_call
jobs:
  l3:
    uses: ./.github/workflows/l3.yml
`,
    );

    const l1 = path.join(wfDir, "l1.yml");
    fs.writeFileSync(
      l1,
      `
on: workflow_call
jobs:
  l2:
    uses: ./.github/workflows/l2.yml
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  l1:
    uses: ./.github/workflows/l1.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "l1/l2/l3/l4/leaf",
      workflowPath: l4,
      sourceTaskName: "leaf",
      needs: [],
    });
  });

  it("throws when nesting depth exceeds 4", () => {
    const wfDir = setup();
    const l5 = path.join(wfDir, "l5.yml");
    fs.writeFileSync(
      l5,
      `
on: workflow_call
jobs:
  leaf:
    runs-on: ubuntu-latest
    steps:
      - run: echo leaf
`,
    );

    const l4 = path.join(wfDir, "l4.yml");
    fs.writeFileSync(
      l4,
      `
on: workflow_call
jobs:
  l5:
    uses: ./.github/workflows/l5.yml
`,
    );

    const l3 = path.join(wfDir, "l3.yml");
    fs.writeFileSync(
      l3,
      `
on: workflow_call
jobs:
  l4:
    uses: ./.github/workflows/l4.yml
`,
    );

    const l2 = path.join(wfDir, "l2.yml");
    fs.writeFileSync(
      l2,
      `
on: workflow_call
jobs:
  l3:
    uses: ./.github/workflows/l3.yml
`,
    );

    const l1 = path.join(wfDir, "l1.yml");
    fs.writeFileSync(
      l1,
      `
on: workflow_call
jobs:
  l2:
    uses: ./.github/workflows/l2.yml
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  l1:
    uses: ./.github/workflows/l1.yml
`,
    );

    expect(() => expandReusableJobs(callerWf, tmpDir)).toThrow(
      /nesting depth exceeds maximum of 4/,
    );
  });

  it("throws on cyclic reusable workflow references", () => {
    const wfDir = setup();
    const aWf = path.join(wfDir, "a.yml");
    const bWf = path.join(wfDir, "b.yml");

    fs.writeFileSync(
      aWf,
      `
on: workflow_call
jobs:
  call-b:
    uses: ./.github/workflows/b.yml
`,
    );

    fs.writeFileSync(
      bWf,
      `
on: workflow_call
jobs:
  call-a:
    uses: ./.github/workflows/a.yml
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  start:
    uses: ./.github/workflows/a.yml
`,
    );

    expect(() => expandReusableJobs(callerWf, tmpDir)).toThrow(/Cycle detected/);
  });

  it("allows the same workflow to be reused by sibling jobs (not a cycle)", () => {
    const wfDir = setup();
    const sharedWf = path.join(wfDir, "shared.yml");
    fs.writeFileSync(
      sharedWf,
      `
on: workflow_call
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - run: echo shared
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  lint:
    uses: ./.github/workflows/shared.yml
  test:
    uses: ./.github/workflows/shared.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(2);
    const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
    expect(byId["lint/run"]).toBeDefined();
    expect(byId["test/run"]).toBeDefined();
  });

  it("inherits caller needs for entry-point jobs in called workflow", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "test.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    needs: build
    uses: ./.github/workflows/test.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    const testJob = entries.find((e) => e.id === "test/test");
    // Entry-point job inherits caller's needs
    expect(testJob!.needs).toEqual(["build"]);
  });

  it("throws when called workflow file not found", () => {
    const wfDir = setup();
    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    uses: ./.github/workflows/nonexistent.yml
`,
    );

    expect(() => expandReusableJobs(callerWf, tmpDir)).toThrow(/Reusable workflow file not found/);
  });

  it("rewires multiple downstream deps when caller has multiple terminal jobs", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "checks.yml");
    fs.writeFileSync(
      calledWf,
      `
on: workflow_call
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  typecheck:
    runs-on: ubuntu-latest
    steps:
      - run: echo typecheck
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  checks:
    uses: ./.github/workflows/checks.yml
  deploy:
    needs: checks
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    const deploy = entries.find((e) => e.id === "deploy");
    // Both lint and typecheck are terminal — deploy depends on both
    expect(deploy!.needs).toEqual(expect.arrayContaining(["checks/lint", "checks/typecheck"]));
    expect(deploy!.needs).toHaveLength(2);
  });

  it("extracts caller with: values as inputs on inlined entries", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "test.yml");
    fs.writeFileSync(
      calledWf,
      `
on:
  workflow_call:
    inputs:
      node-version:
        default: '18'
      environment:
        required: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  test:
    uses: ./.github/workflows/test.yml
    with:
      node-version: '20'
      environment: staging
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.inputs).toEqual({ "node-version": "20", environment: "staging" });
    expect(entry.inputDefaults).toEqual({ "node-version": "18" });
    expect(entry.callerJobId).toBe("test");
  });

  it("extracts workflowCallOutputDefs from called workflow", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "build.yml");
    fs.writeFileSync(
      calledWf,
      `
on:
  workflow_call:
    outputs:
      artifact-url:
        value: \${{ jobs.build.outputs.url }}
      version:
        value: \${{ jobs.build.outputs.version }}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  build:
    uses: ./.github/workflows/build.yml
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].workflowCallOutputDefs).toEqual({
      "artifact-url": "${{ jobs.build.outputs.url }}",
      version: "${{ jobs.build.outputs.version }}",
    });
  });

  it("preserves raw expressions in with: values (does not expand)", () => {
    const wfDir = setup();
    const calledWf = path.join(wfDir, "deploy.yml");
    fs.writeFileSync(
      calledWf,
      `
on:
  workflow_call:
    inputs:
      sha:
        required: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`,
    );

    const callerWf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      callerWf,
      `
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      sha: \${{ github.sha }}
`,
    );

    const entries = expandReusableJobs(callerWf, tmpDir);
    // Raw expression is preserved, not expanded at this stage
    expect(entries[0].inputs).toEqual({ sha: "${{ github.sha }}" });
  });

  it("sets callerJobId, inputs, and inputDefaults as undefined for regular jobs", () => {
    const wfDir = setup();
    const wf = path.join(wfDir, "ci.yml");
    fs.writeFileSync(
      wf,
      `
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`,
    );

    const entries = expandReusableJobs(wf, tmpDir);
    expect(entries[0].callerJobId).toBeUndefined();
    expect(entries[0].inputs).toBeUndefined();
    expect(entries[0].inputDefaults).toBeUndefined();
    expect(entries[0].workflowCallOutputDefs).toBeUndefined();
  });
});
