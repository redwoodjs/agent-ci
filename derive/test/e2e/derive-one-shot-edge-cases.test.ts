// --GROK--: Edge-case E2E tests for one-shot spec update. Covers the two
// scenarios from one-shot-spec-update.feature not addressed by the main
// derive-one-shot.test.ts: no conversations found, and no new messages since
// the last run. Fully black-box — spawns derive as a subprocess and asserts on
// exit code and output text.

import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive one-shot: no conversations found", () => {
  it("exits cleanly and reports that no conversations were found", async () => {
    // --GROK--: No conversations written to the slug dir for this branch.
    // derive should detect the empty set, tell the user, and exit 0.
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);

    // --GROK--: The spec says "a message indicates no conversations were found".
    // We match loosely so the test is not brittle against phrasing changes.
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/no conversations/i);
  }, 30_000);

  it("does not write any .feature files when there are no conversations", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [],
    });

    await run();

    // --GROK--: With no conversations there is nothing to derive, so the spec
    // directory should not be created at all (or be empty).
    const specExists = fs.existsSync(specDir);
    if (specExists) {
      const files = fs.readdirSync(specDir).filter((f) => f.endsWith(".feature"));
      expect(files.length).toBe(0);
    }
  }, 30_000);
});

describe("derive one-shot: no new messages since last run", () => {
  it("exits cleanly on a second run when all conversations are already processed", async () => {
    // --GROK--: Run derive once to process the conversation and record the byte
    // offset in the DB. The second run should see that the offset is at EOF,
    // skip processing, and exit 0 without error.
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add a --verbose flag to show debug output",
            },
            {
              type: "assistant",
              content: "I will add a --verbose flag that enables debug logging",
            },
          ],
        },
      ],
    });

    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);
    expect(firstResult.featureFiles.length).toBeGreaterThan(0);

    // --GROK--: The second run re-uses the same DB (same dbPath captured in the
    // harness closure). The offset recorded by the first run means there is
    // nothing new to process.
    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);
  }, 30_000);

  it("preserves existing .feature files when there is nothing new to process", async () => {
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            { type: "user", content: "Add a --watch flag for live updates" },
            {
              type: "assistant",
              content: "I will implement --watch mode using a file watcher",
            },
          ],
        },
      ],
    });

    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);
    expect(firstResult.featureFiles.length).toBeGreaterThan(0);

    // --GROK--: Capture what the spec files look like after the first run so we
    // can verify they survive the second (no-op) run intact.
    const firstContent = firstResult.featureFiles.map((f) => fs.readFileSync(f, "utf8"));

    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);

    // Spec files should still be present and unchanged after a no-op run.
    expect(secondResult.featureFiles.length).toBe(firstResult.featureFiles.length);
    for (let i = 0; i < firstResult.featureFiles.length; i++) {
      expect(fs.existsSync(firstResult.featureFiles[i])).toBe(true);
      expect(fs.readFileSync(firstResult.featureFiles[i], "utf8")).toBe(firstContent[i]);
    }
  }, 30_000);
});
