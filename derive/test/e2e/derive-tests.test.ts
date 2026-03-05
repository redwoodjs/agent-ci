// --GROK--: E2e tests for `derive tests` — the test generation command. These
// verify the full pipeline: spec files on disk -> derive tests invocation ->
// fake-claude-gen-tests binary reads specs and writes test files.
//
// Unlike the spec pipeline tests (which verify Gherkin output), these verify
// that test files are written to disk as side effects of the agentic Claude call.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest, FAKE_CLAUDE_GEN_TESTS_BIN } from "./harness.js";

const SAMPLE_FEATURE = `Feature: Reset mode

  Scenario: Reset regenerates spec from scratch
    Given the user is in a git repository on branch "feature-x"
    And conversations exist for this branch
    When the user runs derive --reset
    Then all existing .feature files are deleted
    And all conversation offsets are zeroed
    And each conversation is processed sequentially from the start
    And the spec is fully regenerated as per-feature .feature files
`;

const SECOND_FEATURE = `Feature: Watch mode

  Scenario: Watch triggers update on conversation change
    Given the user has started derive watch on branch "feature-x"
    And the watcher is monitoring the slug directory for this cwd
    When a JSONL file in the slug directory is modified
    Then after a debounce period the discover and update flow runs

  Scenario: Watch discovers new conversations
    Given the user has started derive watch on branch "feature-x"
    When a new JSONL file appears in the slug directory
    Then the new file is discovered and indexed if it belongs to this branch
`;

describe("derive tests", () => {
  it("generates test files from spec files", async () => {
    const { repoDir, run } = await setupDeriveTest({
      specs: {
        scope: "derive",
        features: [{ name: "reset-mode.feature", content: SAMPLE_FEATURE }],
      },
      claudeBin: FAKE_CLAUDE_GEN_TESTS_BIN,
      deriveArgs: ["tests", "--scope", "derive"],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);

    // --GROK--: fake-claude-gen-tests writes to <cwd>/test/generated/<slug>.test.ts
    const generatedDir = path.join(repoDir, "test", "generated");
    expect(fs.existsSync(generatedDir)).toBe(true);

    const testFiles = fs.readdirSync(generatedDir).filter((f) => f.endsWith(".test.ts"));
    expect(testFiles.length).toBeGreaterThanOrEqual(1);

    // Verify the test file contains valid vitest structure
    const testContent = fs.readFileSync(path.join(generatedDir, testFiles[0]), "utf8");
    expect(testContent).toContain("import");
    expect(testContent).toContain("describe(");
    expect(testContent).toContain("it(");
    expect(testContent).toContain("expect(");
  }, 30_000);

  it("generates one test file per feature file", async () => {
    const { repoDir, run } = await setupDeriveTest({
      specs: {
        scope: "derive",
        features: [
          { name: "reset-mode.feature", content: SAMPLE_FEATURE },
          { name: "watch-mode.feature", content: SECOND_FEATURE },
        ],
      },
      claudeBin: FAKE_CLAUDE_GEN_TESTS_BIN,
      deriveArgs: ["tests", "--scope", "derive"],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);

    const generatedDir = path.join(repoDir, "test", "generated");
    const testFiles = fs
      .readdirSync(generatedDir)
      .filter((f) => f.endsWith(".test.ts"))
      .sort();
    expect(testFiles.length).toBe(2);

    // --GROK--: Each feature file should produce a test file named by slugifying
    // the Feature: name. "Reset mode" -> "reset-mode.test.ts"
    expect(testFiles).toContain("reset-mode.test.ts");
    expect(testFiles).toContain("watch-mode.test.ts");
  }, 30_000);

  it("test files contain scenarios from the spec", async () => {
    const { repoDir, run } = await setupDeriveTest({
      specs: {
        scope: "derive",
        features: [{ name: "watch-mode.feature", content: SECOND_FEATURE }],
      },
      claudeBin: FAKE_CLAUDE_GEN_TESTS_BIN,
      deriveArgs: ["tests", "--scope", "derive"],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);

    const generatedDir = path.join(repoDir, "test", "generated");
    const testContent = fs.readFileSync(path.join(generatedDir, "watch-mode.test.ts"), "utf8");

    // --GROK--: The fake binary turns each Scenario: into an it() block
    expect(testContent).toContain("Watch triggers update on conversation change");
    expect(testContent).toContain("Watch discovers new conversations");
  }, 30_000);

  it("does not require git branch or conversations", async () => {
    // --GROK--: derive tests should work without conversations or CLAUDE_PROJECTS_DIR.
    // We pass no conversations — the command should still succeed because it only
    // reads spec files, not JSONL conversations.
    const { run } = await setupDeriveTest({
      specs: {
        scope: "derive",
        features: [{ name: "reset-mode.feature", content: SAMPLE_FEATURE }],
      },
      claudeBin: FAKE_CLAUDE_GEN_TESTS_BIN,
      deriveArgs: ["tests", "--scope", "derive"],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
  }, 30_000);
});
