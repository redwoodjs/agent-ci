// E2E tests for spec-file-location.feature. Verifies that derive
// always writes .feature files to .machinen/specs/ inside the current working
// directory (the git repository), never to a global or user-level location.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setupDeriveTest } from "./harness.js";

describe("derive spec file location", () => {
  it("writes spec files to .machinen/specs/ inside the project directory", async () => {
    const { repoDir, specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --location-flag to set the output location",
            },
            { type: "assistant", content: "I will add --location-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    // specDir is path.join(repoDir, ".machinen", "specs"). Every
    // produced file must sit inside this directory, not anywhere else.
    const expectedSpecDir = path.join(repoDir, ".machinen", "specs");
    expect(specDir).toBe(expectedSpecDir);

    for (const filePath of result.featureFiles) {
      expect(filePath.startsWith(expectedSpecDir)).toBe(true);
    }
  }, 30_000);

  it("creates the .machinen/specs/ directory if it does not exist", async () => {
    const { specDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --mkdir-flag to auto-create output directories",
            },
            { type: "assistant", content: "I will add --mkdir-flag" },
          ],
        },
      ],
    });

    // Confirm the spec dir does not exist before the run.
    expect(fs.existsSync(specDir)).toBe(false);

    const result = await run();

    expect(result.exitCode).toBe(0);

    // derive must create the directory tree as needed.
    expect(fs.existsSync(specDir)).toBe(true);
    expect(result.featureFiles.length).toBeGreaterThan(0);
  }, 30_000);

  it("does not write spec files to any location outside the project directory", async () => {
    const { repoDir, run } = await setupDeriveTest({
      branch: "feature-x",
      conversations: [
        {
          messages: [
            {
              type: "user",
              content: "Add --safe-flag for safe mode operations",
            },
            { type: "assistant", content: "I will add --safe-flag" },
          ],
        },
      ],
    });

    const result = await run();

    expect(result.exitCode).toBe(0);
    expect(result.featureFiles.length).toBeGreaterThan(0);

    // All produced files must be rooted under repoDir. This guards
    // against any accidental writes to ~/.machinen/ or other global paths.
    for (const filePath of result.featureFiles) {
      expect(filePath.startsWith(repoDir)).toBe(true);
    }
  }, 30_000);
});
