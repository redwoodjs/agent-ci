import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  assertNoUnsupportedFeatures,
  COMPATIBILITY_DOC_URL,
  LOCAL_WORKFLOW_SUPPORT_ISSUE_URL,
} from "./unsupported-features.js";

describe("assertNoUnsupportedFeatures", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function writeWorkflowTree(content: string): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-unsupported-"));
    const workflowDir = path.join(tmpDir, ".github", "workflows");
    fs.mkdirSync(workflowDir, { recursive: true });
    const filePath = path.join(workflowDir, "test.yml");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function escaped(text: string): RegExp {
    return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  it("fails with actionable guidance for local uses steps", () => {
    const filePath = writeWorkflowTree(`
name: Local Action Skip Test
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: ./actions/local-build
      - uses: actions/checkout@v4
`);

    expect(() => assertNoUnsupportedFeatures(filePath, "test")).toThrow(
      /Local composite action ".\/actions\/local-build" is not supported in job "test"/,
    );
    expect(() => assertNoUnsupportedFeatures(filePath, "test")).toThrow(
      escaped(LOCAL_WORKFLOW_SUPPORT_ISSUE_URL),
    );
    expect(() => assertNoUnsupportedFeatures(filePath, "test")).toThrow(/See Progress:/);
    expect(() => assertNoUnsupportedFeatures(filePath, "test")).toThrow(/Workaround:/);
  });

  it("fails fast with actionable guidance for reusable workflow jobs", () => {
    const filePath = writeWorkflowTree(`
name: Reusable Workflow Job Test
on: [push]
jobs:
  lint:
    uses: ./.github/workflows/lint.yml
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).toThrow(
      /Local reusable workflow ".\/\.github\/workflows\/lint.yml" is not supported in job "lint"/,
    );
    expect(() => assertNoUnsupportedFeatures(filePath)).toThrow(
      escaped(LOCAL_WORKFLOW_SUPPORT_ISSUE_URL),
    );
  });

  it("fails fast for unsupported workflow_call trigger", () => {
    const filePath = writeWorkflowTree(`
name: Reusable Entrypoint
on:
  workflow_call:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).toThrow(
      /Reusable workflow trigger `on\.workflow_call` is not supported/,
    );
    expect(() => assertNoUnsupportedFeatures(filePath)).toThrow(/Workaround:/);
  });

  it("warns and continues for unsupported step continue-on-error", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = writeWorkflowTree(`
name: Unsupported Step Flag
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        continue-on-error: true
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Step-level `continue-on-error` is not supported in job "test"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(COMPATIBILITY_DOC_URL));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Ignore locally:"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("- Step-level `continue-on-error`"),
    );

    warnSpy.mockRestore();
  });

  it("warns and continues for unsupported workflow-level concurrency", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = writeWorkflowTree(`
name: Unsupported Concurrency
on: [push]
concurrency: ci-main
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Workflow-level concurrency is not supported"),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(COMPATIBILITY_DOC_URL));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("See compatibility:"));

    warnSpy.mockRestore();
  });

  it("groups multiple warn-only unsupported features into one ignore-locally block", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = writeWorkflowTree(`
name: Warn Grouping
on: [push]
concurrency: ci-main
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo hi
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Ignore locally:\n- Workflow-level concurrency is not supported"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '- Job-level timeout `timeout-minutes` is not supported in job "test"',
      ),
    );

    warnSpy.mockRestore();
  });

  it("prints ignore-locally warnings before fail-fast unsupported error", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const filePath = writeWorkflowTree(`
name: Warn Then Fail
on: [push]
concurrency: ci-main
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ./.github/actions/generate_cache_key
`);

    expect(() => assertNoUnsupportedFeatures(filePath)).toThrow(
      /Local composite action ".\/\.github\/actions\/generate_cache_key" is not supported/,
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Ignore locally:\n- Workflow-level concurrency is not supported"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        '- Job-level timeout `timeout-minutes` is not supported in job "test"',
      ),
    );

    warnSpy.mockRestore();
  });

  it.todo("supports local composite actions from ./ paths without fail-fast rejection");
  it.todo("supports reusable workflow jobs (jobs.<id>.uses) with parity to GitHub Actions");
});
