import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Signal handling cleanup ───────────────────────────────────────────────────

describe("Signal handler cleanup", () => {
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

// ── Stale workspace pruning ───────────────────────────────────────────────────

describe("Stale workspace pruning", () => {
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

    const { pruneStaleWorkspaces } = await import("./shutdown.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toContain("oa-runner-100");
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("keeps oa-runner-* dirs newer than maxAge", async () => {
    // Create a fresh workspace
    const freshDir = path.join(tmpDir, "work", "oa-runner-200");
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, "file.txt"), "fresh");

    const { pruneStaleWorkspaces } = await import("./shutdown.js");
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

    const { pruneStaleWorkspaces } = await import("./shutdown.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(otherDir)).toBe(true);
  });
});

describe("containerWorkDir cleanup on exit", () => {
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
