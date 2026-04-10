import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { computeDirtySha } from "./dirty-sha.js";

describe("computeDirtySha", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "dirty-sha-test-"));
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
    // Create an initial commit so HEAD exists
    fs.writeFileSync(path.join(repoDir, "initial.txt"), "initial");
    execSync("git add -A && git commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns undefined for a clean working tree", () => {
    expect(computeDirtySha(repoDir)).toBeUndefined();
  });

  it("returns a SHA when tracked files are modified", () => {
    fs.writeFileSync(path.join(repoDir, "initial.txt"), "modified");
    const sha = computeDirtySha(repoDir);
    expect(sha).toBeDefined();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns a SHA when untracked files are present", () => {
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "new file");
    const sha = computeDirtySha(repoDir);
    expect(sha).toBeDefined();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns a different SHA for different dirty states", () => {
    fs.writeFileSync(path.join(repoDir, "a.txt"), "content a");
    const sha1 = computeDirtySha(repoDir);

    // Stage and commit a.txt, then modify differently
    execSync("git add -A && git commit -m 'add a'", { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "a.txt"), "content b");
    const sha2 = computeDirtySha(repoDir);

    expect(sha1).toBeDefined();
    expect(sha2).toBeDefined();
    expect(sha1).not.toBe(sha2);
  });

  it("does not move HEAD or create refs", () => {
    const headBefore = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();
    const refsBefore = execSync("git for-each-ref", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();

    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "dirty");
    computeDirtySha(repoDir);

    const headAfter = execSync("git rev-parse HEAD", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();
    const refsAfter = execSync("git for-each-ref", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();

    expect(headAfter).toBe(headBefore);
    expect(refsAfter).toBe(refsBefore);
  });

  it("does not modify the real index", () => {
    // Stage nothing, but have an untracked file
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "new");

    const statusBefore = execSync("git status --porcelain", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();

    computeDirtySha(repoDir);

    const statusAfter = execSync("git status --porcelain", { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();

    expect(statusAfter).toBe(statusBefore);
  });

  it("returns a valid commit object parented on HEAD", () => {
    fs.writeFileSync(path.join(repoDir, "dirty.txt"), "content");
    const sha = computeDirtySha(repoDir);
    expect(sha).toBeDefined();

    // Verify it's a valid commit object
    const type = execSync(`git cat-file -t ${sha}`, { cwd: repoDir, stdio: "pipe" })
      .toString()
      .trim();
    expect(type).toBe("commit");

    // Read the parent SHA directly from the commit object (bypasses any git shims
    // that intercept `git rev-parse HEAD` in CI environments).
    const commitBody = execSync(`git cat-file -p ${sha}`, {
      cwd: repoDir,
      stdio: "pipe",
    }).toString();
    const parentMatch = commitBody.match(/^parent ([0-9a-f]{40})$/m);
    expect(parentMatch).not.toBeNull();

    // Read HEAD the same way to compare — resolve the ref from .git/HEAD.
    const headContent = fs.readFileSync(path.join(repoDir, ".git", "HEAD"), "utf-8").trim();
    const headSha = headContent.startsWith("ref: ")
      ? fs.readFileSync(path.join(repoDir, ".git", headContent.slice(5)), "utf-8").trim()
      : headContent;

    expect(parentMatch![1]).toBe(headSha);
  });
});
