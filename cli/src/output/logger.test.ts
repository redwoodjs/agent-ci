import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Logger utilities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ci-logger-test-"));
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
    it("creates runDir/logs/ and returns correct paths", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const ctx = createLogContext("agent-ci");
      expect(ctx.name).toMatch(/^agent-ci-\d+$/);
      expect(fs.existsSync(ctx.runDir)).toBe(true);
      expect(fs.existsSync(ctx.logDir)).toBe(true);
      expect(ctx.outputLogPath).toBe(path.join(ctx.logDir, "output.log"));
      expect(ctx.debugLogPath).toBe(path.join(ctx.logDir, "debug.log"));
    });

    it("uses preferredName when provided", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const ctx = createLogContext("agent-ci", "agent-ci-redwoodjssdk-42");
      expect(ctx.name).toBe("agent-ci-redwoodjssdk-42");
      expect(ctx.runDir).toBe(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-42"));
      expect(ctx.logDir).toBe(path.join(tmpDir, "runs", "agent-ci-redwoodjssdk-42", "logs"));
    });

    it("auto-increments when no preferredName given", async () => {
      const { setWorkingDirectory } = await import("./working-directory.js");
      const { createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const first = createLogContext("agent-ci");
      const second = createLogContext("agent-ci");
      expect(second.num).toBe(first.num + 1);
    });
  });
});
