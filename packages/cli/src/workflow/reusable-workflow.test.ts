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
    expect(entries[0]).toEqual({
      id: "lint/lint",
      workflowPath: calledWf,
      sourceTaskName: "lint",
      needs: [],
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

  it("skips remote uses refs with a warning", () => {
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

    const entries = expandReusableJobs(callerWf, tmpDir);
    // Remote reusable workflow is skipped; only build remains
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("build");
  });

  it("throws on nested reusable workflows", () => {
    const wfDir = setup();
    const innerWf = path.join(wfDir, "inner.yml");
    fs.writeFileSync(
      innerWf,
      `
on: workflow_call
jobs:
  nested:
    uses: ./.github/workflows/something.yml
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

    expect(() => expandReusableJobs(callerWf, tmpDir)).toThrow(
      /Nested reusable workflows are not supported/,
    );
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

  it("handles called workflow file not found gracefully", () => {
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

    const entries = expandReusableJobs(callerWf, tmpDir);
    // nonexistent file is skipped; only build remains
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("build");
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
});
