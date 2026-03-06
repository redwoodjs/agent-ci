import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "./working-directory.js";

/** Root of all run directories: `<workingDir>/runs/` */
export function getRunsDir(): string {
  return path.join(getWorkingDirectory(), "runs");
}

/**
 * @deprecated use getRunsDir() + runnerName for the per-run log directory.
 * Kept for the supervisor.log placement only.
 */
export function getLogsDir(): string {
  return path.join(getWorkingDirectory(), "logs");
}

export function ensureLogDirs(): void {
  fs.mkdirSync(getRunsDir(), { recursive: true });
}

export function getNextLogNum(prefix: string): number {
  const runsDir = getRunsDir();
  if (!fs.existsSync(runsDir)) {
    return 1;
  }

  const items = fs.readdirSync(runsDir, { withFileTypes: true });
  const nums = items
    .filter((item) => item.isDirectory() && item.name.startsWith(`${prefix}-`))
    .map((item) => {
      // Extract the trailing numeric run counter from a name like:
      //   machinen-redwoodjssdk-14        → 14
      //   machinen-redwoodjssdk-15-j1     → 15
      //   machinen-redwoodjssdk-15-j1-m2  → 15
      // Strategy: strip any -j<N>, -m<N>, -r<N> suffixes first, then grab the last number.
      const baseName = item.name
        .replace(/-j\d+(-m\d+)?(-r\d+)?$/, "")
        .replace(/-m\d+(-r\d+)?$/, "")
        .replace(/-r\d+$/, "");
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

  const runDir = path.join(getRunsDir(), name);
  const logDir = path.join(runDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });

  return {
    num,
    name,
    runDir,
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
