import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import fs from "fs";
import {
  ensureLogDirs,
  getNextLogNum,
  createLogContext,
  finalizeLog,
  getLogsDir,
} from "./logger.js";

vi.mock("fs", () => {
  return {
    default: {
      mkdirSync: vi.fn(),
      existsSync: vi.fn(),
      readdirSync: vi.fn(),
    },
  };
});

describe("logger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureLogDirs", () => {
    it("should recursively create the logs directory", () => {
      ensureLogDirs();
      expect(fs.mkdirSync).toHaveBeenCalledWith(getLogsDir(), { recursive: true });
    });
  });

  describe("getNextLogNum", () => {
    it("should return 1 when logs directory does not exist", () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const num = getNextLogNum("test-prefix");
      expect(num).toBe(1);
      expect(fs.existsSync).toHaveBeenCalledWith(getLogsDir());
    });

    it("should return 1 when logs directory is empty", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      const num = getNextLogNum("test-prefix");
      expect(num).toBe(1);
    });

    it("should return incremented number based on existing directories", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { isDirectory: () => true, name: "test-prefix-1" },
        { isDirectory: () => true, name: "test-prefix-5" },
        { isDirectory: () => true, name: "test-prefix-2" },
      ] as any);

      const num = getNextLogNum("test-prefix");
      expect(num).toBe(6);
    });

    it("should ignore unrelated directories/files", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { isDirectory: () => true, name: "test-prefix-1" },
        { isDirectory: () => false, name: "test-prefix-10" }, // not a dir
        { isDirectory: () => true, name: "other-prefix-20" },
      ] as any);

      const num = getNextLogNum("test-prefix");
      expect(num).toBe(2);
    });
  });

  describe("createLogContext", () => {
    it("should create directory for the current prefix and log context", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { isDirectory: () => true, name: "runner-1" },
      ] as any);

      const context = createLogContext("runner");

      expect(context.num).toBe(2);
      expect(context.name).toBe("runner-2");
      expect(context.logDir).toBe(path.join(getLogsDir(), "runner-2"));
      expect(context.outputLogPath).toBe(path.join(getLogsDir(), "runner-2", "output.log"));
      expect(context.debugLogPath).toBe(path.join(getLogsDir(), "runner-2", "debug.log"));

      expect(fs.mkdirSync).toHaveBeenCalledWith(getLogsDir(), { recursive: true });
      expect(fs.mkdirSync).toHaveBeenCalledWith(context.logDir, { recursive: true });
    });

    it("should use preferredName and skip incrementing if provided", () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const context = createLogContext("runner", "custom-runner-name");

      expect(context.num).toBe(0);
      expect(context.name).toBe("custom-runner-name");
      expect(context.logDir).toBe(path.join(getLogsDir(), "custom-runner-name"));
      expect(context.outputLogPath).toBe(
        path.join(getLogsDir(), "custom-runner-name", "output.log"),
      );
      expect(context.debugLogPath).toBe(path.join(getLogsDir(), "custom-runner-name", "debug.log"));

      // Also ensure it didn't call readdirSync to find the next number
      expect(fs.readdirSync).not.toHaveBeenCalled();
      expect(fs.mkdirSync).toHaveBeenCalledWith(context.logDir, { recursive: true });
    });
  });

  describe("finalizeLog", () => {
    it("should return the log path unmodified", () => {
      const result = finalizeLog("/fake/log/path", 0, "commit-sha", "job-name");
      expect(result).toBe("/fake/log/path");
    });
  });
});
