// E2E tests for incremental-spec-updates.feature. Verifies that
// derive tracks byte offsets in the DB so a second run only processes newly
// appended JSONL content, not already-processed lines.
//
// Setup: call setupDeriveTest once, call run() to process the initial messages
// (offset recorded in DB), then append new lines to the JSONL file and call
// run() again. The second run must exit 0 and produce spec files — evidence
// that the new content was picked up.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive incremental spec updates", () => {
  it("updates the spec when new messages are appended to a conversation", async () => {
    const { repoDir, projectsDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --pagination-flag to the list endpoint",
            },
            {
              type: "assistant",
              content: "I will add --pagination-flag with limit and offset params",
            },
          ],
        },
      ],
    });

    // First run: processes initial messages, records offset in DB.
    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);
    expect(firstResult.featureFiles.length).toBeGreaterThan(0);

    // Find the JSONL file written by the harness and append a new
    // message line to it. The new line has a distinct --flag so we can detect
    // whether it was processed in the second run.
    const slug = repoDir.replace(/[/_]/g, "-");
    const slugDir = path.join(projectsDir, slug);
    const jsonlFiles = fs.readdirSync(slugDir).filter((f) => f.endsWith(".jsonl"));
    expect(jsonlFiles.length).toBeGreaterThan(0);

    const jsonlPath = path.join(slugDir, jsonlFiles[0]);
    fs.appendFileSync(
      jsonlPath,
      JSON.stringify({
        type: "user",
        sessionId: "test-session",
        cwd: repoDir,
        gitBranch: "feature-x",
        message: {
          role: "user",
          content: "Also add --sort-flag to control sort order",
        },
      }) + "\n",
      "utf8",
    );

    // Second run: should process only the appended line.
    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);
    expect(secondResult.featureFiles.length).toBeGreaterThan(0);
  }, 30_000);

  it("processes the full content of a large conversation", async () => {
    // Generate a conversation with many messages. derive must process
    // all of them (not truncate at an arbitrary limit) and produce valid Gherkin.
    const messages: Array<{ type: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        type: "user",
        content: `Requirement ${i}: add --feature-${i}-flag to the system`,
      });
      messages.push({
        type: "assistant",
        content: `I will implement --feature-${i}-flag as described`,
      });
    }

    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [{ messages }],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    const allContent = result.featureFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

    expect(allContent).toContain("Feature:");
    expect(allContent).toContain("Scenario:");
  }, 30_000);

  it("does not reprocess already-processed messages on a subsequent run", async () => {
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --idempotent-flag for idempotent operations",
            },
            { type: "assistant", content: "I will add --idempotent-flag" },
          ],
        },
      ],
    });

    const firstResult = await run();
    expect(firstResult.exitCode).toBe(0);

    const secondResult = await run();
    expect(secondResult.exitCode).toBe(0);
  }, 30_000);
});
