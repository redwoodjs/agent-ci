import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "./working-directory.js";

/** Root of all run directories: `<workingDir>/runs/` */
function getRunsDir(): string {
  return path.join(getWorkingDirectory(), "runs");
}

export function ensureLogDirs(): void {
  fs.mkdirSync(getRunsDir(), { recursive: true });
}

export function getNextLogNum(prefix: string): number {
  const runsDir = getRunsDir();
  fs.mkdirSync(runsDir, { recursive: true });

  const items = fs.readdirSync(runsDir, { withFileTypes: true });
  const nums = items
    .filter((item) => item.isDirectory() && item.name.startsWith(`${prefix}-`))
    .map((item) => {
      // Extract the trailing numeric run counter from a name like:
      //   agent-ci-redwoodjssdk-14        → 14
      //   agent-ci-redwoodjssdk-15-j1     → 15
      //   agent-ci-redwoodjssdk-15-j1-m2  → 15
      // Strategy: strip any -j<N>, -m<N>, -r<N> suffixes first, then grab the last number.
      const baseName = item.name
        .replace(/-j\d+(-m\d+)?(-r\d+)?$/, "")
        .replace(/-m\d+(-r\d+)?$/, "")
        .replace(/-r\d+$/, "");
      const match = baseName.match(/-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });

  const maxNum = nums.length > 0 ? Math.max(...nums) : 0;

  // Atomically claim the next available number by creating the directory.
  // fs.mkdirSync (without recursive) throws EEXIST if the directory already
  // exists, making the claim race-free across concurrent jobs/workflows.
  for (let n = maxNum + 1; n <= maxNum + 100; n++) {
    try {
      fs.mkdirSync(path.join(runsDir, `${prefix}-${n}`));
      return n;
    } catch (err: any) {
      if (err.code === "EEXIST") {
        continue;
      }
      throw err;
    }
  }

  throw new Error(`[Agent CI] Could not allocate a unique run number for '${prefix}'`);
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
