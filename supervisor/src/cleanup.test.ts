import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ── Workspace copy tests ──────────────────────────────────────────────────────

describe("copyWorkspace", () => {
  let repoDir: string;
  let destDir: string;

  beforeEach(() => {
    // Create a real git repo with tracked, untracked, and gitignored files
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-copy-test-repo-"));
    destDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-copy-test-dest-"));

    // Init git repo
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });

    // Create tracked files
    fs.writeFileSync(path.join(repoDir, "README.md"), "# Hello");
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "console.log('hello')");

    // Create .gitignore
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "node_modules/\ndist/\n*.log\n");

    // Create gitignored files (should NOT be copied)
    fs.mkdirSync(path.join(repoDir, "node_modules", "foo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "node_modules", "foo", "index.js"), "module.exports = {}");
    fs.mkdirSync(path.join(repoDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "dist", "bundle.js"), "bundled");
    fs.writeFileSync(path.join(repoDir, "debug.log"), "log data");

    // Commit everything that's tracked
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "initial"', { cwd: repoDir, stdio: "pipe" });

    // Create untracked-but-not-ignored file (should be copied)
    fs.writeFileSync(path.join(repoDir, "newfile.txt"), "untracked but not ignored");
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(destDir, { recursive: true, force: true });
  });

  it("copies tracked files", async () => {
    const { copyWorkspace } = await import("./cleanup.js");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "README.md"), "utf-8")).toBe("# Hello");
    expect(fs.existsSync(path.join(destDir, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".gitignore"))).toBe(true);
  });

  it("copies untracked-but-not-ignored files", async () => {
    const { copyWorkspace } = await import("./cleanup.js");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "newfile.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "newfile.txt"), "utf-8")).toBe(
      "untracked but not ignored",
    );
  });

  it("excludes gitignored files", async () => {
    const { copyWorkspace } = await import("./cleanup.js");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "debug.log"))).toBe(false);
  });

  it("preserves nested directory structure", async () => {
    const { copyWorkspace } = await import("./cleanup.js");
    copyWorkspace(repoDir, destDir);

    expect(fs.readFileSync(path.join(destDir, "src", "index.ts"), "utf-8")).toBe(
      "console.log('hello')",
    );
  });
});
