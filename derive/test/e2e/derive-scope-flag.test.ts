// --GROK--: E2E tests for scope-flag.feature. Verifies that --scope <name>
// redirects spec file I/O to .machinen/specs/<name>/ instead of the default
// .machinen/specs/ directory. Also verifies reset respects the scoped directory
// and that without --scope the default location is used.
//
// Because the harness's featureFiles helper only reads one level deep from
// specDir (i.e. .machinen/specs/), scoped files must be found by reading the
// subdirectory manually.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive --scope flag", () => {
  it("writes spec files to .machinen/specs/<scope>/ when --scope is provided", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --scope-flag to namespace the spec output",
            },
            { type: "assistant", content: "I will add --scope-flag" },
          ],
        },
      ],
      deriveArgs: ["--scope", "myapp"],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);

    // --GROK--: With --scope myapp, files must land in .machinen/specs/myapp/,
    // not directly in .machinen/specs/. The harness featureFiles array will be
    // empty because it only reads one level deep; we read the subdir ourselves.
    const scopedDir = path.join(specDir, "myapp");
    expect(fs.existsSync(scopedDir)).toBe(true);

    const scopedFiles = fs.readdirSync(scopedDir).filter((f) => f.endsWith(".feature"));
    expect(scopedFiles.length).toBeGreaterThan(0);

    // Must NOT write files directly to the unscoped specDir.
    const unscopedFiles = fs.readdirSync(specDir).filter((f) => f.endsWith(".feature"));
    expect(unscopedFiles.length).toBe(0);
  }, 30_000);

  it("reads existing spec files from .machinen/specs/<scope>/ when --scope is provided", async () => {
    // --GROK--: Pre-seed the scoped directory with a spec file. The second run
    // should read it as context. We verify this by checking that a second run
    // (which processes no new messages) still exits 0 without error, implying
    // derive successfully found and read the scoped spec directory.
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --read-scope-flag to read from scoped dir",
            },
            { type: "assistant", content: "I will add --read-scope-flag" },
          ],
        },
      ],
      deriveArgs: ["--scope", "myapp"],
    });

    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);

    const scopedDir = path.join(specDir, "myapp");
    const filesAfterFirst = fs.readdirSync(scopedDir).filter((f) => f.endsWith(".feature"));
    expect(filesAfterFirst.length).toBeGreaterThan(0);

    // Second run — reads scoped spec files as context, finds no new messages.
    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);

    // Scoped files must still be present.
    const filesAfterSecond = fs.readdirSync(scopedDir).filter((f) => f.endsWith(".feature"));
    expect(filesAfterSecond.length).toBeGreaterThan(0);
  }, 30_000);

  it("without --scope writes spec files to the default .machinen/specs/ location", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --default-flag for default location behaviour",
            },
            { type: "assistant", content: "I will add --default-flag" },
          ],
        },
      ],
      // No deriveArgs — no --scope flag.
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    // --GROK--: All files must live directly in specDir, not in a subdirectory.
    for (const filePath of result.featureFiles) {
      expect(path.dirname(filePath)).toBe(specDir);
    }
  }, 30_000);

  it("--reset --scope deletes and regenerates only the scoped directory", async () => {
    // --GROK--: Pre-seed both the scoped directory and a file outside it. After
    // derive --reset --scope myapp, the scoped files must be cleared and
    // regenerated while the file outside the scope is untouched.
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --scoped-reset-flag to reset only the scoped spec",
            },
            { type: "assistant", content: "I will add --scoped-reset-flag" },
          ],
        },
      ],
      deriveArgs: ["--reset", "--scope", "myapp"],
    });

    // Pre-seed the scoped directory with a stale file.
    const scopedDir = path.join(specDir, "myapp");
    fs.mkdirSync(scopedDir, { recursive: true });
    const staleScoped = path.join(scopedDir, "stale-scoped.feature");
    fs.writeFileSync(
      staleScoped,
      "Feature: Stale scoped\n\n  Scenario: Old\n    Given g\n    When w\n    Then t\n",
      "utf8",
    );

    // Pre-seed a file directly in specDir (outside the scope).
    const outsideFile = path.join(specDir, "outside-scope.feature");
    fs.writeFileSync(
      outsideFile,
      "Feature: Outside scope\n\n  Scenario: Preserved\n    Given g\n    When w\n    Then t\n",
      "utf8",
    );

    const result = await run();

    expect(result.exitCode).toBe(0);

    // Stale scoped file must be removed.
    expect(fs.existsSync(staleScoped)).toBe(false);

    // New scoped files must be written.
    const newScopedFiles = fs.readdirSync(scopedDir).filter((f) => f.endsWith(".feature"));
    expect(newScopedFiles.length).toBeGreaterThan(0);

    // --GROK--: File outside the scope must not be affected by the scoped reset.
    expect(fs.existsSync(outsideFile)).toBe(true);
  }, 30_000);
});
