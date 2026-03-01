import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Pinned to the monorepo root (project root), not the supervisor package
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

let workingDirectory = path.join(PROJECT_ROOT, "_");

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}

export function getLogsDir(): string {
  return path.join(workingDirectory, "logs");
}

export function ensureLogDirs(): void {
  fs.mkdirSync(getLogsDir(), { recursive: true });
}

export function getNextLogNum(prefix: string): number {
  const logsDir = getLogsDir();
  if (!fs.existsSync(logsDir)) {
    return 1;
  }

  const items = fs.readdirSync(logsDir, { withFileTypes: true });
  const nums = items
    .filter((item) => item.isDirectory() && item.name.startsWith(`${prefix}-`))
    .map((item) => {
      // Strip any trailing -NNN job-suffix (e.g. oa-runner-50-001 → oa-runner-50)
      // before extracting the base run number so multi-job names don't skew the counter.
      const baseName = item.name.replace(/-\d{3}$/, "");
      const match = baseName.match(/-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

export function createLogContext(prefix: string, preferredName?: string) {
  ensureLogDirs();

  let num = 0;
  let name = preferredName;

  if (!name) {
    num = getNextLogNum(prefix);
    name = `${prefix}-${num}`;
  }

  const logDir = path.join(getLogsDir(), name);
  fs.mkdirSync(logDir, { recursive: true });

  return {
    num,
    name,
    logDir,
    outputLogPath: path.join(logDir, "output.log"),
    debugLogPath: path.join(logDir, "debug.log"),
  };
}

export function finalizeLog(
  logPath: string,
  _exitCode: number,
  _commitSha?: string,
  _preferredName?: string,
): string {
  // Log file stays in place; just return the path as-is.
  return logPath;
}
