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
    const { computeLockfileHash } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("returns the same hash for the same lockfile content", async () => {
    const { computeLockfileHash } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    expect(computeLockfileHash(repoDir)).toBe(computeLockfileHash(repoDir));
  });

  it("returns a different hash when lockfile content changes", async () => {
    const { computeLockfileHash } = await import("./cleanup.js");
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
    const { computeLockfileHash } = await import("./cleanup.js");
    // Empty repo, no lockfile
    fs.writeFileSync(path.join(repoDir, "README.md"), "hi");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    expect(computeLockfileHash(repoDir)).toBe("no-lockfile");
  });

  it("detects package-lock.json (npm)", async () => {
    const { computeLockfileHash } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("detects yarn.lock", async () => {
    const { computeLockfileHash } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "yarn.lock"), "# yarn lockfile v1");
    execSync("git add .", { cwd: repoDir, stdio: "pipe" });
    execSync('git commit -m "init"', { cwd: repoDir, stdio: "pipe" });

    const hash = computeLockfileHash(repoDir);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it("detects bun.lock", async () => {
    const { computeLockfileHash } = await import("./cleanup.js");
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
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    expect(detectPackageManager(repoDir)).toBe("pnpm");
  });

  it("detects npm from package-lock.json", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    expect(detectPackageManager(repoDir)).toBe("npm");
  });

  it("detects yarn from yarn.lock", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "yarn.lock"), "# yarn lockfile v1");
    expect(detectPackageManager(repoDir)).toBe("yarn");
  });

  it("detects bun from bun.lock", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "bun.lock"), '{"lockfileVersion": 0}');
    expect(detectPackageManager(repoDir)).toBe("bun");
  });

  it("detects bun from bun.lockb", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "bun.lockb"), Buffer.from([0x00]));
    expect(detectPackageManager(repoDir)).toBe("bun");
  });

  it("returns null when no lockfile exists", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    expect(detectPackageManager(repoDir)).toBeNull();
  });

  it("prefers pnpm over npm when both lockfiles exist", async () => {
    const { detectPackageManager } = await import("./cleanup.js");
    fs.writeFileSync(path.join(repoDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    fs.writeFileSync(path.join(repoDir, "package-lock.json"), '{"lockfileVersion": 3}');
    expect(detectPackageManager(repoDir)).toBe("pnpm");
  });
});

// ── isWarmNodeModules tests ───────────────────────────────────────────────────

describe("isWarmNodeModules", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-warm-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for a non-existent directory", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    expect(isWarmNodeModules(path.join(tmpDir, "does-not-exist"))).toBe(false);
  });

  it("returns false for an empty directory", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);
    expect(isWarmNodeModules(emptyDir)).toBe(false);
  });

  it("returns false when directory has files but no .modules.yaml (corrupted)", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, "some-package"), "content");
    expect(isWarmNodeModules(warmDir)).toBe(false);
  });

  it("returns true when directory has .modules.yaml (pnpm)", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, ".modules.yaml"), "hoistedDependencies: {}");
    fs.mkdirSync(path.join(warmDir, ".pnpm"), { recursive: true });
    expect(isWarmNodeModules(warmDir)).toBe(true);
  });

  it("returns true when directory has .package-lock.json (npm)", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm-npm");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, ".package-lock.json"), "{}");
    fs.writeFileSync(path.join(warmDir, "express"), "pkg");
    expect(isWarmNodeModules(warmDir)).toBe(true);
  });

  it("returns true when directory has .yarn-integrity (yarn)", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm-yarn");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, ".yarn-integrity"), "{}");
    fs.writeFileSync(path.join(warmDir, "express"), "pkg");
    expect(isWarmNodeModules(warmDir)).toBe(true);
  });

  it("returns true when directory has .cache (bun)", async () => {
    const { isWarmNodeModules } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm-bun");
    fs.mkdirSync(warmDir);
    fs.mkdirSync(path.join(warmDir, ".cache"));
    fs.writeFileSync(path.join(warmDir, "express"), "pkg");
    expect(isWarmNodeModules(warmDir)).toBe(true);
  });
});

// ── repairWarmCache tests ─────────────────────────────────────────────────────

describe("repairWarmCache", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-repair-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'cold' for a non-existent directory", async () => {
    const { repairWarmCache } = await import("./cleanup.js");
    expect(repairWarmCache(path.join(tmpDir, "nope"))).toBe("cold");
  });

  it("returns 'cold' for an empty directory", async () => {
    const { repairWarmCache } = await import("./cleanup.js");
    const emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);
    expect(repairWarmCache(emptyDir)).toBe("cold");
  });

  it("returns 'warm' when .modules.yaml exists (pnpm)", async () => {
    const { repairWarmCache } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, ".modules.yaml"), "ok");
    expect(repairWarmCache(warmDir)).toBe("warm");
  });

  it("returns 'warm' when .package-lock.json exists (npm)", async () => {
    const { repairWarmCache } = await import("./cleanup.js");
    const warmDir = path.join(tmpDir, "warm-npm");
    fs.mkdirSync(warmDir);
    fs.writeFileSync(path.join(warmDir, ".package-lock.json"), "{}");
    expect(repairWarmCache(warmDir)).toBe("warm");
  });

  it("returns 'repaired' and nukes a corrupted cache (files but no sentinel)", async () => {
    const { repairWarmCache } = await import("./cleanup.js");
    const brokenDir = path.join(tmpDir, "broken");
    fs.mkdirSync(path.join(brokenDir, ".pnpm", "yaml@2.8.2"), { recursive: true });
    fs.writeFileSync(path.join(brokenDir, ".pnpm", "yaml@2.8.2", "Pair.js"), "broken");

    expect(repairWarmCache(brokenDir)).toBe("repaired");
    // Directory should be recreated empty
    expect(fs.existsSync(brokenDir)).toBe(true);
    expect(fs.readdirSync(brokenDir)).toHaveLength(0);
  });
});
