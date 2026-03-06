import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseJobDependencies, topoSort } from "./job-scheduler.js";

describe("parseJobDependencies", () => {
  let tmpDir: string;

  function writeWorkflow(content: string): string {
    const filePath = path.join(tmpDir, "workflow.yml");
    fs.writeFileSync(filePath, content, "utf-8");
    return filePath;
  }

  it("returns empty deps for jobs without needs", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
    const wf = writeWorkflow(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hello
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo world
`);
    const deps = parseJobDependencies(wf);
    expect(deps.get("build")).toEqual([]);
    expect(deps.get("test")).toEqual([]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses string needs", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
    const wf = writeWorkflow(`
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
`);
    const deps = parseJobDependencies(wf);
    expect(deps.get("build")).toEqual([]);
    expect(deps.get("test")).toEqual(["build"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses array needs", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-test-"));
    const wf = writeWorkflow(`
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: echo lint
  deploy:
    needs: [build, lint]
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`);
    const deps = parseJobDependencies(wf);
    expect(deps.get("build")).toEqual([]);
    expect(deps.get("lint")).toEqual([]);
    expect(deps.get("deploy")).toEqual(["build", "lint"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty map for non-existent file", () => {
    const deps = parseJobDependencies("/tmp/nonexistent.yml");
    expect(deps.size).toBe(0);
  });
});

describe("topoSort", () => {
  it("puts all independent jobs in one wave", () => {
    const deps = new Map([
      ["a", [] as string[]],
      ["b", [] as string[]],
      ["c", [] as string[]],
    ]);
    const waves = topoSort(deps);
    expect(waves).toEqual([["a", "b", "c"]]);
  });

  it("creates two waves for a simple dependency chain", () => {
    const deps = new Map([
      ["build", [] as string[]],
      ["test", ["build"]],
    ]);
    const waves = topoSort(deps);
    expect(waves).toEqual([["build"], ["test"]]);
  });

  it("creates correct waves for mixed dependencies", () => {
    const deps = new Map([
      ["build", [] as string[]],
      ["lint", [] as string[]],
      ["test", ["build"]],
      ["deploy", ["build", "lint"]],
    ]);
    const waves = topoSort(deps);
    // Wave 1: build, lint (no deps)
    // Wave 2: test, deploy (all deps in wave 1)
    expect(waves[0]).toEqual(expect.arrayContaining(["build", "lint"]));
    expect(waves[1]).toEqual(expect.arrayContaining(["test", "deploy"]));
    expect(waves.length).toBe(2);
  });

  it("creates three waves for a chain: build -> test -> deploy", () => {
    const deps = new Map([
      ["build", [] as string[]],
      ["test", ["build"]],
      ["deploy", ["test"]],
    ]);
    const waves = topoSort(deps);
    expect(waves).toEqual([["build"], ["test"], ["deploy"]]);
  });

  it("handles cycles gracefully by dumping remaining into one wave", () => {
    const deps = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const waves = topoSort(deps);
    // Should still produce output (fallback to one wave)
    expect(waves.length).toBe(1);
    expect(waves[0]).toEqual(expect.arrayContaining(["a", "b"]));
  });
});
