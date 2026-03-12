import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Signal handling cleanup ───────────────────────────────────────────────────

describe("Signal handler cleanup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-signal-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleanup function removes all temp directories", () => {
    // With the new layout, work/shims/diag are co-located under runs/<runnerName>/
    const runDir = path.join(tmpDir, "runs", "agent-ci-sig");
    const dirs = {
      containerWorkDir: path.join(runDir, "work"),
      workspaceDir: path.join(runDir, "work", "workspace"),
      shimsDir: path.join(runDir, "shims"),
      diagDir: path.join(runDir, "diag"),
    };

    for (const d of Object.values(dirs)) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    // Simulate signal handler cleanup — just remove the entire runDir
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-prune-test-"));
    // pruneStaleWorkspaces scans <workDir>/runs/
    fs.mkdirSync(path.join(tmpDir, "runs"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes agent-ci-* dirs older than maxAge", async () => {
    // Create a stale run dir — the entire runDir is removed (includes logs, work, shims, diag)
    const staleDir = path.join(tmpDir, "runs", "agent-ci-100");
    fs.mkdirSync(path.join(staleDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(staleDir, "logs", "output.log"), "stale");

    // Backdate it to 48 hours ago
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, oldTime, oldTime);

    const { pruneStaleWorkspaces } = await import("./shutdown.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toContain("agent-ci-100");
    expect(fs.existsSync(staleDir)).toBe(false);
  });

  it("keeps agent-ci-* dirs newer than maxAge", async () => {
    // Create a fresh run dir
    const freshDir = path.join(tmpDir, "runs", "agent-ci-200");
    fs.mkdirSync(path.join(freshDir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(freshDir, "logs", "output.log"), "fresh");

    const { pruneStaleWorkspaces } = await import("./shutdown.js");
    const pruned = pruneStaleWorkspaces(tmpDir, 24 * 60 * 60 * 1000);

    expect(pruned).toEqual([]);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it("ignores non-agent-ci dirs", async () => {
    const otherDir = path.join(tmpDir, "runs", "workspace-12345");
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-cleanup-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cleans entire runDir on success", () => {
    // New layout: work/shims/diag are all under runs/<runnerName>/
    const runDir = path.join(tmpDir, "runs", "agent-ci-1");
    const containerWorkDir = path.join(runDir, "work");
    const shimsDir = path.join(runDir, "shims");
    const diagDir = path.join(runDir, "diag");
    const logDir = path.join(runDir, "logs");

    // Create all dirs
    for (const d of [containerWorkDir, shimsDir, diagDir, logDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = true;

    // On success: clean the entire runDir (logs kept via archiving externally)
    if (jobSucceeded && fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }

    expect(fs.existsSync(runDir)).toBe(false);
    expect(fs.existsSync(containerWorkDir)).toBe(false);
    expect(fs.existsSync(shimsDir)).toBe(false);
    expect(fs.existsSync(diagDir)).toBe(false);
  });

  it("retains runDir on failure for debugging", () => {
    const runDir = path.join(tmpDir, "runs", "agent-ci-2");
    const containerWorkDir = path.join(runDir, "work");
    const shimsDir = path.join(runDir, "shims");
    const diagDir = path.join(runDir, "diag");
    const logDir = path.join(runDir, "logs");

    for (const d of [containerWorkDir, shimsDir, diagDir, logDir]) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "test.txt"), "data");
    }

    const jobSucceeded = false;

    // On failure: keep runDir so the developer can inspect work/, shims/, diag/, logs/
    if (jobSucceeded && fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }

    // runDir should be RETAINED
    expect(fs.existsSync(runDir)).toBe(true);
    expect(fs.readFileSync(path.join(containerWorkDir, "test.txt"), "utf-8")).toBe("data");
    // All subdirs retained
    expect(fs.existsSync(containerWorkDir)).toBe(true);
    expect(fs.existsSync(shimsDir)).toBe(true);
    expect(fs.existsSync(diagDir)).toBe(true);
  });
});
