import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Logger utilities", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "machinen-logger-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("ensureLogDirs", () => {
    it("creates the runs/ directory", async () => {
      const { setWorkingDirectory, ensureLogDirs } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      ensureLogDirs();
      expect(fs.existsSync(path.join(tmpDir, "runs"))).toBe(true);
    });
  });

  describe("getNextLogNum", () => {
    it("returns 1 when runs/ dir is empty or absent", async () => {
      const { setWorkingDirectory, getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      expect(getNextLogNum("machinen")).toBe(1);
    });

    it("returns next number after existing machinen-* entries", async () => {
      const { setWorkingDirectory, getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      fs.mkdirSync(path.join(tmpDir, "runs", "machinen-1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "machinen-2"), { recursive: true });
      expect(getNextLogNum("machinen")).toBe(3);
    });

    it("counts only the base run number from multi-job names", async () => {
      const { setWorkingDirectory, getNextLogNum } = await import("./logger.js");
      setWorkingDirectory(tmpDir);
      // Multi-job run: machinen-15 with -j1-m2 suffix — base is 15
      fs.mkdirSync(path.join(tmpDir, "runs", "machinen-redwoodjssdk-14"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "machinen-redwoodjssdk-15-j1"), { recursive: true });
      fs.mkdirSync(path.join(tmpDir, "runs", "machinen-redwoodjssdk-15-j2-m1"), {
        recursive: true,
      });
      expect(getNextLogNum("machinen")).toBe(16);
    });
  });

  describe("createLogContext", () => {
    it("creates runDir/logs/ and returns correct paths", async () => {
      const { setWorkingDirectory, createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const ctx = createLogContext("machinen");
      expect(ctx.name).toMatch(/^machinen-\d+$/);
      expect(fs.existsSync(ctx.runDir)).toBe(true);
      expect(fs.existsSync(ctx.logDir)).toBe(true);
      expect(ctx.outputLogPath).toBe(path.join(ctx.logDir, "output.log"));
      expect(ctx.debugLogPath).toBe(path.join(ctx.logDir, "debug.log"));
    });

    it("uses preferredName when provided", async () => {
      const { setWorkingDirectory, createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const ctx = createLogContext("machinen", "machinen-redwoodjssdk-42");
      expect(ctx.name).toBe("machinen-redwoodjssdk-42");
      expect(ctx.runDir).toBe(path.join(tmpDir, "runs", "machinen-redwoodjssdk-42"));
      expect(ctx.logDir).toBe(path.join(tmpDir, "runs", "machinen-redwoodjssdk-42", "logs"));
    });

    it("auto-increments when no preferredName given", async () => {
      const { setWorkingDirectory, createLogContext } = await import("./logger.js");
      setWorkingDirectory(tmpDir);

      const first = createLogContext("machinen");
      const second = createLogContext("machinen");
      expect(second.num).toBe(first.num + 1);
    });
  });
});
