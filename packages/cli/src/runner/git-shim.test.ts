import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── writeGitShim ──────────────────────────────────────────────────────────────

describe("writeGitShim", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shim-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an executable git shim with the correct SHA", async () => {
    const { writeGitShim } = await import("./git-shim.js");
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    writeGitShim(tmpDir, sha);

    const shimPath = path.join(tmpDir, "git");
    expect(fs.existsSync(shimPath)).toBe(true);

    const content = fs.readFileSync(shimPath, "utf-8");
    expect(content).toContain("#!/bin/bash");
    expect(content).toContain(sha);
    expect(content).toContain("ls-remote");
    expect(content).toContain("git.real");

    // Check executable permission
    const stat = fs.statSync(shimPath);
    expect(stat.mode & 0o755).toBe(0o755);
  });

  it("includes all required interception clauses", async () => {
    const { writeGitShim } = await import("./git-shim.js");
    writeGitShim(tmpDir, "abc");

    const content = fs.readFileSync(path.join(tmpDir, "git"), "utf-8");
    // All key interception points
    expect(content).toContain("config --local --get remote.origin.url");
    expect(content).toContain("ls-remote");
    expect(content).toContain("fetch");
    expect(content).toContain("rev-parse");
    expect(content).toContain("clean");
    expect(content).toContain("checkout");
    expect(content).toContain("pass-through");
  });
});
