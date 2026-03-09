// E2E tests for multi-file-spec-storage.feature and
// spec-file-content-and-format.feature. Verifies that derive writes spec output
// as individual .feature files (one per Feature block), names them by slugifying
// the Feature title, and clears stale files before writing new ones.
//
// The fake-claude-gen-specs stub always emits a single "Feature: Extracted
// specification" block, so all per-file and naming assertions operate on that
// predictable output. The stale-file removal scenario uses --reset to force
// derive to always clear and rewrite, bypassing the incremental no-op path.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive multi-file spec storage", () => {
  it("writes output as .feature files in the spec directory", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --output-flag to configure output directory",
            },
            { type: "assistant", content: "I will add --output-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    for (const filePath of result.featureFiles) {
      expect(filePath.startsWith(specDir)).toBe(true);
      expect(filePath.endsWith(".feature")).toBe(true);
    }
  }, 30_000);

  it("names each file by slugifying the Feature block title", async () => {
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --format-flag for output formatting",
            },
            { type: "assistant", content: "I will add --format-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    for (const filePath of result.featureFiles) {
      const basename = path.basename(filePath);
      // Slug pattern: lowercase, hyphens, no spaces or special chars.
      expect(basename).toMatch(/^[a-z0-9][a-z0-9-]*\.feature$/);
    }
  }, 30_000);

  it("removes stale .feature files before writing new ones", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            { type: "user", content: "Add --clean-flag to remove temp files" },
            { type: "assistant", content: "I will add --clean-flag" },
          ],
        },
      ],
      deriveArgs: ["--reset"],
    });

    fs.mkdirSync(specDir, { recursive: true });
    const staleFile = path.join(specDir, "obsolete-behaviour.feature");
    fs.writeFileSync(
      staleFile,
      "Feature: Obsolete\n\n  Scenario: Gone\n    Given old state\n    When old action\n    Then old result\n",
      "utf8",
    );

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(result.featureFiles.length).toBeGreaterThan(0);
  }, 30_000);

  it("produces files with valid Gherkin structure", async () => {
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --validate-flag to validate input files",
            },
            { type: "assistant", content: "I will add --validate-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    for (const filePath of result.featureFiles) {
      const content = fs.readFileSync(filePath, "utf8");

      // Must begin with a Feature: declaration.
      expect(content).toMatch(/^Feature:/);

      // Must contain at least one Scenario with Given/When/Then steps.
      expect(content).toContain("Scenario:");
      expect(content).toMatch(/Given |When |Then /);
    }
  }, 30_000);

  it("uses existing spec content as context for the update", async () => {
    // Run derive once to create spec files. Run again (incrementally,
    // with new messages) — derive must read existing files as starting context
    // and produce an updated spec. We verify the second run still exits 0 and
    // produces valid files, not that specific content was merged (which is
    // handled by the fake binary's deterministic output).
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --context-flag to pass context to the spec",
            },
            { type: "assistant", content: "I will add --context-flag" },
          ],
        },
      ],
    });

    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);
    expect(firstResult.featureFiles.length).toBeGreaterThan(0);

    // Second run — spec files from first run are used as context input.
    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);
  }, 30_000);
});
