import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Logger utilities", () => {
  let tmpDir: string;
  let logsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-logger-test-"));
    logsDir = path.join(tmpDir, "logs-root");
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("ensureLogDirs", () => {
    it("creates the runs/ directory", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { ensureLogDirs } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      ensureLogDirs();
      expect(fs.existsSync(path.join(tmpDir, "runs"))).toBe(true);
    });
  });

  describe("getNextLogNum", () => {
    it("returns 1 when runs/ dir is empty or absent", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      expect(getNextLogNum("agent-ci")).toBe(1);
    });

    it("returns next number after existing agent-ci-* entries", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-2"), { recursive: true });
      expect(getNextLogNum("agent-ci")).toBe(3);
    });

    it("counts only the base run number from multi-job names", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      // Multi-job run: agent-ci-15 with -j1-m2 suffix — base is 15
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-14"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-15-j1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-15-j2-m1"), {
        recursive: true,
      });
      expect(getNextLogNum("agent-ci")).toBe(16);
    });
  });

  describe("createLogContext", () => {
    it("creates runDir under workingDir and logDir under logsDir", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const ctx = createLogContext("agent-ci");
      expect(ctx.name).toMatch(/^agent-ci-\d+$/);
      expect(ctx.runDir.startsWith(path.join(tmpDir, "runs"))).toBe(true);
      expect(ctx.logDir.startsWith(logsDir)).toBe(true);
      expect(fs.existsSync(ctx.runDir)).toBe(true);
      expect(fs.existsSync(ctx.logDir)).toBe(true);
      expect(ctx.outputLogPath).toBe(path.join(ctx.logDir, "output.log"));
      expect(ctx.debugLogPath).toBe(path.join(ctx.logDir, "debug.log"));
    });

    it("uses preferredName when provided", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const ctx = createLogContext("agent-ci", "agent-ci-redwoodjssdk-42");
      expect(ctx.name).toBe("agent-ci-redwoodjssdk-42");
      expect(ctx.runDir).toBe(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-42"));
      expect(ctx.logDir).toBe(path.join(logsDir, "agent-ci-redwoodjssdk-42"));
    });

    it("auto-increments when no preferredName given", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      const first = createLogContext("agent-ci");
      const second = createLogContext("agent-ci");
      expect(second.num).toBe(first.num + 1);
    });

    it("skips over a directory that already exists (race condition)", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Pre-create runs/agent-ci-1 to simulate another process winning the race
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-1"), { recursive: true });

      const ctx = createLogContext("agent-ci");
      // Should have skipped 1 and landed on 2
      expect(ctx.num).toBe(2);
      expect(ctx.name).toBe("agent-ci-2");
      expect(fs.existsSync(ctx.runDir)).toBe(true);
    });

    it("handles multiple consecutive collisions", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Pre-create 1, 2, and 3 to simulate several concurrent processes
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-2"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "agent-ci-3"), { recursive: true });

      const ctx = createLogContext("agent-ci");
      expect(ctx.num).toBe(4);
      expect(ctx.name).toBe("agent-ci-4");
      expect(fs.existsSync(ctx.runDir)).toBe(true);
    });

    it("concurrent calls each get a unique directory", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { setLogsDirectory } = await import("./logs-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      setLogsDirectory(logsDir);

      // Call createLogContext many times synchronously — each should get a unique dir
      const results = Array.from({ length: 10 }, () => createLogContext("agent-ci"));

      const names = results.map((r) => r.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(10);

      // All directories should exist
      for (const r of results) {
        expect(fs.existsSync(r.runDir)).toBe(true);
        expect(fs.existsSync(r.logDir)).toBe(true);
      }
    });
  });
});
