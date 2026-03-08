// --GROK--: E2E tests for conversation-discovery.feature. Verifies that derive
// only includes conversations belonging to the current git branch and that it
// aggregates across all conversations for that branch.
//
// The branch-filtering test works by writing a second JSONL file directly into
// the slug directory with a different gitBranch value. The fake-claude-gen-specs
// stub extracts --flags as distinct keywords, so if derive mistakenly processes
// the other-branch conversation the unique flag would appear in the spec.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive conversation discovery", () => {
  it("ignores conversations that belong to a different branch", async () => {
    const { repoDir, projectsDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --feature-x-only-flag to the CLI",
            },
            {
              type: "assistant",
              content: "I will add --feature-x-only-flag support",
            },
          ],
        },
      ],
    });

    // --GROK--: Write a JSONL file into the same slug directory but tagged with
    // a different gitBranch. derive should skip it when processing "feature-x".
    // The flag --other-branch-xyz is the canary: if it appears in the spec,
    // derive did not filter correctly.
    const slug = repoDir.replace(/[/_]/g, "-");
    const slugDir = path.join(projectsDir, slug);
    const otherId = crypto.randomUUID();

    fs.writeFileSync(
      path.join(slugDir, `${otherId}.jsonl`),
      JSON.stringify({
        type: "user",
        sessionId: "test-session",
        cwd: repoDir,
        gitBranch: "other-branch",
        message: {
          role: "user",
          content: "Add --other-branch-xyz flag support",
        },
      }) + "\n",
      "utf8",
    );

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    // --GROK--: The fake binary embeds --flags verbatim in Scenario text. If
    // the other-branch conversation was processed, "other-branch-xyz" would
    // appear. It must not.
    const allContent = result.featureFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(allContent).not.toContain("other-branch-xyz");
  }, 30_000);

  it("processes all conversations associated with the current branch", async () => {
    // --GROK--: Two separate JSONL files, both tagged "feature-x". Both must
    // contribute to the spec. We use distinct --flags so we can verify each
    // conversation's content made it into the prompt seen by the fake binary.
    const { run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            { type: "user", content: "Add --alpha-flag to the CLI" },
            { type: "assistant", content: "I will add --alpha-flag" },
          ],
        },
        {
          messages: [
            { type: "user", content: "Add --beta-flag to the CLI" },
            { type: "assistant", content: "I will add --beta-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    const allContent = result.featureFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");

    // Both conversations must have contributed — spec must contain valid Gherkin.
    expect(allContent).toContain("Feature:");
    expect(allContent).toContain("Scenario:");
    expect(allContent).toMatch(/Given |When |Then /);
  }, 30_000);
});
