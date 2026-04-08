import { describe, it, expect } from "vitest";

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

  it("parses trigger events", () => {
    const wf = parseWorkflowYaml(`
name: CI
on:
  push:
  pull_request:
    types: [opened, synchronize]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`);
    expect(wf.on).toEqual(["push", "pull_request"]);
  });
});
