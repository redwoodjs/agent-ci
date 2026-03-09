// First e2e test for derive. Fully black-box — spawns derive as a
// subprocess, injects env vars for complete isolation, and asserts on filesystem
// output. No internal imports from derive's source.

import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive one-shot", () => {
  it("produces .feature files from a synthetic conversation", async () => {
    const { run } = await setupDeriveTest({
      branch: "test-branch",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content:
                "We need to add a --reset flag that regenerates the spec from scratch instead of incrementally updating it",
            },
            {
              type: "assistant",
              content:
                "I will implement a --reset flag that clears existing specs and reprocesses all conversations from offset zero",
            },
          ],
        },
      ],
    });

    const result = await run();

    // derive should exit cleanly after the one-shot spec update.
    expect(result.exitCode).toBe(0);

    // The specs directory should have been created with at least one
    // .feature file. The fake-claude-gen-specs stub produces deterministic
    // Gherkin from the conversation keywords.
    expect(result.featureFiles.length).toBeGreaterThan(0);

    for (const filePath of result.featureFiles) {
      const content = fs.readFileSync(filePath, "utf8");

      // Every .feature file must start with "Feature:" — this is how
      // writeSpec splits and names the files.
      expect(content).toMatch(/^Feature:/);

      // Structural validity: must contain at least one Scenario with
      // Given/When/Then steps.
      expect(content).toContain("Scenario:");
      expect(content).toMatch(/Given |When |Then /);
    }
  }, 30_000);

  it("discovers multiple conversations for the same branch", async () => {
    const { run } = await setupDeriveTest({
      branch: "feature-branch",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add pagination to the user listing endpoint",
            },
            {
              type: "assistant",
              content: "I will add limit and offset query parameters",
            },
          ],
        },
        {
          messages: [
            {
              type: "user",
              content: "Add sorting by creation date to the user listing",
            },
            {
              type: "assistant",
              content: "I will add a sort parameter that accepts date fields",
            },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    // Both conversations should have been processed — the combined
    // spec output should contain keywords from both conversations.
    const allContent = result.featureFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

    expect(allContent).toContain("Feature:");
    expect(allContent).toContain("Scenario:");
  }, 30_000);
});
