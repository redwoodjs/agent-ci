import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// Pinned to the monorepo root (project root), not the supervisor package
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
export const LOGS_DIR = path.join(PROJECT_ROOT, "_", "logs");

export function ensureLogDirs(): void {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

export function getNextLogNum(prefix: string): number {
  if (!fs.existsSync(LOGS_DIR)) {
    return 1;
  }

  const items = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
  const nums = items
    .filter((item) => item.isDirectory() && item.name.startsWith(`${prefix}-`))
    .map((item) => {
      const match = item.name.match(/-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

export function createLogContext(prefix: string) {
  ensureLogDirs();
  const num = getNextLogNum(prefix);
  const name = `${prefix}-${num}`;
  const logDir = path.join(LOGS_DIR, name);
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
