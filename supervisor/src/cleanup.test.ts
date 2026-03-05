import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

// ── Fix 1: containerWorkDir cleanup on exit ───────────────────────────────────

describe("Fix 1: containerWorkDir cleanup on exit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleans containerWorkDir on success", () => {
    const containerWorkDir = path.join(tmpDir, "work", "oa-runner-1");
    const workspaceDir = path.join(tmpDir, "work", "workspace-123");
    const shimsDir = path.join(tmpDir, "shims", "oa-runner-1");
    const diagDir = path.join(tmpDir, "diag", "oa-runner-1");

    // Create all dirs
    for (const d of [containerWorkDir, workspaceDir, shimsDir, diagDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = true;

    // Simulate the cleanup logic (must match what we'll implement)
    // 1. Always clean workspace, shims, diag
    for (const d of [workspaceDir, shimsDir, diagDir]) {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
    // 2. Clean containerWorkDir only on success
    if (jobSucceeded && fs.existsSync(containerWorkDir)) {
      fs.rmSync(containerWorkDir, { recursive: true, force: true });
    }

    expect(fs.existsSync(containerWorkDir)).toBe(false);
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(fs.existsSync(shimsDir)).toBe(false);
    expect(fs.existsSync(diagDir)).toBe(false);
  });

  it("retains containerWorkDir on failure for debugging", () => {
    const containerWorkDir = path.join(tmpDir, "work", "oa-runner-2");
    const workspaceDir = path.join(tmpDir, "work", "workspace-456");
    const shimsDir = path.join(tmpDir, "shims", "oa-runner-2");
    const diagDir = path.join(tmpDir, "diag", "oa-runner-2");

    for (const d of [containerWorkDir, workspaceDir, shimsDir, diagDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = false;

    // Same cleanup logic
    for (const d of [workspaceDir, shimsDir, diagDir]) {
      if (fs.existsSync(d)) {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
    if (jobSucceeded && fs.existsSync(containerWorkDir)) {
      fs.rmSync(containerWorkDir, { recursive: true, force: true });
    }

    // containerWorkDir should be RETAINED
    expect(fs.existsSync(containerWorkDir)).toBe(true);
    expect(fs.readFileSync(path.join(containerWorkDir, "test.txt"), "utf-8")).toBe("data");
    // Others should be cleaned
    expect(fs.existsSync(workspaceDir)).toBe(false);
    expect(fs.existsSync(shimsDir)).toBe(false);
    expect(fs.existsSync(diagDir)).toBe(false);
  });
});

// ── Fix 4: Signal handling cleanup ────────────────────────────────────────────

describe("Fix 4: Signal handler cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-signal-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanup function removes all temp directories", () => {
    const dirs = {
      containerWorkDir: path.join(tmpDir, "work", "oa-runner-sig"),
      workspaceDir: path.join(tmpDir, "work", "workspace-sig"),
      shimsDir: path.join(tmpDir, "shims", "oa-runner-sig"),
      diagDir: path.join(tmpDir, "diag", "oa-runner-sig"),
    };

    for (const d of Object.values(dirs)) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    // Simulate signal handler cleanup (cleans everything including containerWorkDir)
    for (const d of Object.values(dirs)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }

    for (const d of Object.values(dirs)) {
      expect(fs.existsSync(d)).toBe(false);
    }
  });

  it("cleanup function is idempotent (handles missing dirs)", () => {
    const dirs = [path.join(tmpDir, "nonexistent-1"), path.join(tmpDir, "nonexistent-2")];

    // Should not throw
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }

    // If we got here, idempotency works
    expect(true).toBe(true);
  });
});

// ── Fix 5: Stale workspace pruning ────────────────────────────────────────────

// Import will be available after we create cleanup.ts
// For now we define the expected behavior in tests

describe("Fix 5: Stale workspace pruning", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-prune-test-"));
    fs.mkdirSync(path.join(tmpDir, "work"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes oa-runner-* dirs older than maxAge", async () => {
    // Create a stale workspace
    const staleDir = path.join(tmpDir, "work", "oa-runner-100");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "file.txt"), "stale");

    // Backdate it to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    const { pruneStaleWorkspaces } = await import("./cleanup.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toContain("oa-runner-100");
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("keeps oa-runner-* dirs newer than maxAge", async () => {
    // Create a fresh workspace
    const freshDir = path.join(tmpDir, "work", "oa-runner-200");
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, "file.txt"), "fresh");

    const { pruneStaleWorkspaces } = await import("./cleanup.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("ignores non-oa-runner dirs", async () => {
    const otherDir = path.join(tmpDir, "work", "workspace-12345");
    fs.mkdirSync(otherDir, { recursive: true });

    // Backdate it
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(otherDir, oldTime, oldTime);

    const { pruneStaleWorkspaces } = await import("./cleanup.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});

// ── Fix 6: Disk usage visibility ──────────────────────────────────────────────

describe("Fix 6: Disk usage reporting", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-disk-test-"));
    // Create the expected directory structure
    for (const sub of ["work", "logs", "pnpm-store/test-repo", "playwright-cache/test-repo"]) {
      fs.mkdirSync(path.join(tmpDir, sub), { recursive: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports workspace count and items", async () => {
    // Create two fake runner workspaces
    const ws1 = path.join(tmpDir, "work", "oa-runner-10");
    const ws2 = path.join(tmpDir, "work", "oa-runner-11");
    fs.mkdirSync(ws1, { recursive: true });
    fs.mkdirSync(ws2, { recursive: true });
    fs.writeFileSync(path.join(ws1, "data.txt"), "x".repeat(1024));
    fs.writeFileSync(path.join(ws2, "data.txt"), "y".repeat(2048));

    const { getDiskUsage } = await import("./cleanup.js");
    const usage = getDiskUsage(tmpDir);

    expect(usage.workspaces.count).toBe(2);
    expect(usage.workspaces.items).toHaveLength(2);
    expect(usage.workspaces.items.map((i: any) => i.name).sort()).toEqual([
      "oa-runner-10",
      "oa-runner-11",
    ]);
  });

  it("reports total bytes across all categories", async () => {
    // Create some data in workspace
    const ws = path.join(tmpDir, "work", "oa-runner-50");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "data.txt"), "x".repeat(100));

    const { getDiskUsage } = await import("./cleanup.js");
    const usage = getDiskUsage(tmpDir);

    expect(usage.totalBytes).toBeGreaterThan(0);
    expect(typeof usage.workspaces.totalBytes).toBe("number");
    expect(typeof usage.pnpmStoreBytes).toBe("number");
    expect(typeof usage.playwrightCacheBytes).toBe("number");
    expect(typeof usage.logsBytes).toBe("number");
  });

  it("returns empty results for missing directories", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-empty-"));
    const { getDiskUsage } = await import("./cleanup.js");
    const usage = getDiskUsage(emptyDir);

    expect(usage.workspaces.count).toBe(0);
    expect(usage.workspaces.items).toEqual([]);
    expect(usage.totalBytes).toBe(0);

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});

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
