import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import {
  DEFAULT_WORKING_DIR,
  PROJECT_ROOT,
  getWorkingDirectory,
  setWorkingDirectory,
} from "./working-directory.js";

describe("working-directory", () => {
  it("uses environment-appropriate DEFAULT_WORKING_DIR", () => {
    const expected = fs.existsSync("/.dockerenv")
      ? path.join(PROJECT_ROOT, ".agent-ci")
      : path.join(os.homedir(), ".agent-ci", path.basename(PROJECT_ROOT));

    expect(DEFAULT_WORKING_DIR).toBe(expected);
  });

  it("setWorkingDirectory updates the current working directory", () => {
    const original = getWorkingDirectory();
    const next = path.join(os.tmpdir(), "agent-ci-test-working-dir");

    setWorkingDirectory(next);
    expect(getWorkingDirectory()).toBe(next);

    setWorkingDirectory(original);
  });
});
