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
    const { copyWorkspace } = await import("./cleanup.ts");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "README.md"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "README.md"), "utf-8")).toBe("# Hello");
    expect(fs.existsSync(path.join(destDir, "src", "index.ts"))).toBe(true);
    expect(fs.existsSync(path.join(destDir, ".gitignore"))).toBe(true);
  });

  it("copies untracked-but-not-ignored files", async () => {
    const { copyWorkspace } = await import("./cleanup.ts");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "newfile.txt"))).toBe(true);
    expect(fs.readFileSync(path.join(destDir, "newfile.txt"), "utf-8")).toBe(
      "untracked but not ignored",
    );
  });

  it("excludes gitignored files", async () => {
    const { copyWorkspace } = await import("./cleanup.ts");
    copyWorkspace(repoDir, destDir);

    expect(fs.existsSync(path.join(destDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(destDir, "debug.log"))).toBe(false);
  });

  it("preserves nested directory structure", async () => {
    const { copyWorkspace } = await import("./cleanup.ts");
    copyWorkspace(repoDir, destDir);

    expect(fs.readFileSync(path.join(destDir, "src", "index.ts"), "utf-8")).toBe(
      "console.log('hello')",
    );
  });

  it("preserves git-tracked symlinks", async () => {
    // Create a shared directory and a symlink to it (like Khan/wonder-blocks)
    fs.mkdirSync(path.join(repoDir, "types"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "types", "global.d.ts"), "declare module 'aphrodite';");
    fs.mkdirSync(path.join(repoDir, "packages", "pkg-a"), { recursive: true });
    fs.symlinkSync("../../types", path.join(repoDir, "packages", "pkg-a", "types"));

    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "add symlink"', { cwd: repoDir, stdio: "pipe" });

    const { copyWorkspace } = await import("./cleanup.ts");
    copyWorkspace(repoDir, destDir);

    const copiedLink = path.join(destDir, "packages", "pkg-a", "types");
    const stat = fs.lstatSync(copiedLink);
    expect(stat.isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(copiedLink)).toBe("../../types");
  });
});

// ── computeLockfileHash tests ─────────────────────────────────────────────────

describe("computeLockfileHash", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-hash-test-"));
    execSync("git init", { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.name "test"', { cwd: repoDir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns a hex string for a repo with a tracked lockfile", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns the same hash for the same lockfile content", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    expect(computeLockfileHash(repoDir)).toBe(computeLockfileHash(repoDir));
  });

  it("returns a different hash when lockfile content changes", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });
    const hash1 = computeLockfileHash(repoDir);

    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# changed\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "update"', { cwd: repoDir, stdio: "pipe" });
    const hash2 = computeLockfileHash(repoDir);

    expect(hash1).not.toBe(hash2);
  });

  it("returns 'no-lockfile' when no lockfile exists", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    // Empty repo, no lockfile
    fs.writeFileSync(path.join(repoDir, "README.md"), "hi");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    expect(computeLockfileHash(repoDir)).toBe("no-lockfile");
  });

  it("detects package-lock.json (npm)", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("detects yarn.lock", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "yarn.lock"), "# yarn lockfile v1");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("detects bun.lock", async () => {
    const { computeLockfileHash } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), '{"lockfileVersion": 0}');
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ── detectPackageManager tests ────────────────────────────────────────────────

describe("detectPackageManager", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-pm-detect-"));
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("detects pnpm from pnpm-lock.yaml", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(detectPackageManager(repoDir)).toBe("pnpm");
  });

  it("detects npm from package-lock.json", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    expect(detectPackageManager(repoDir)).toBe("npm");
  });

  it("detects yarn from yarn.lock", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "yarn.lock"), "# yarn lockfile v1");
    expect(detectPackageManager(repoDir)).toBe("yarn");
  });

  it("detects bun from bun.lock", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), '{"lockfileVersion": 0}');
    expect(detectPackageManager(repoDir)).toBe("bun");
  });

  it("detects bun from bun.lockb", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "bun.lockb"), Buffer.from([0x00]));
    expect(detectPackageManager(repoDir)).toBe("bun");
  });

  it("returns null when no lockfile exists", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    expect(detectPackageManager(repoDir)).toBeNull();
  });

  it("prefers pnpm over npm when both lockfiles exist", async () => {
    const { detectPackageManager } = await import("./cleanup.ts");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    expect(detectPackageManager(repoDir)).toBe("pnpm");
  });
});
