import path from "path";
import fs from "fs";
import { getWorkingDirectory } from "./working-directory.js";
import { getLogsDirectory } from "./logs-directory.js";

/** Root of all run directories: `<workingDir>/runs/` */
function getRunsDir(): string {
  return path.join(getWorkingDirectory(), "runs");
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

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

/**
 * Atomically allocate a numbered run directory under `runs/`.
 * Uses mkdirSync without `recursive` so that EEXIST signals a
 * collision — the caller just increments and retries.
 */
function allocateRunDir(prefix: string): { num: number; name: string; runDir: string } {
  const runsDir = getRunsDir();
  let num = getNextLogNum(prefix);

  for (;;) {
    const name = `${prefix}-${num}`;
    const runDir = path.join(runsDir, name);
    try {
      fs.mkdirSync(runDir); // atomic — fails with EEXIST on collision
      return { num, name, runDir };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        num++;
        continue;
      }
      throw err;
    }
  }
}

export function createLogContext(prefix: string, preferredName?: string) {
  ensureLogDirs();

  let num: number;
  let name: string;
  let runDir: string;

  if (preferredName) {
    num = 0;
    name = preferredName;
    runDir = path.join(getRunsDir(), name);
    fs.mkdirSync(runDir, { recursive: true });
  } else {
    ({ num, name, runDir } = allocateRunDir(prefix));
  }

  // Run logs live under a stable, agent-ci-owned directory (default `<stateDir>/logs/`),
  // not next to the runner's working dir which lands in `os.tmpdir()` and gets pruned
  // by the OS. Keeps log paths in run-result JSON resolvable after the OS cleans tmp.
  // See issue #312.
  const logDir = path.join(getLogsDirectory(), name);
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
