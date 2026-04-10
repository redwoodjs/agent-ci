import fs from "fs";
import path from "path";
import { getWorkingDirectory } from "./working-directory.js";

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
      const baseName = item.name
        .replace(/-j\d+(-m\d+)?(-r\d+)?$/, "")
        .replace(/-m\d+(-r\d+)?$/, "")
        .replace(/-r\d+$/, "");
      const match = baseName.match(/-(\d+)$/);
      return match ? parseInt(match[1], 10) : 0;
    });

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "EACCES" || maybeCode === "EPERM";
}

function allocateRunDir(prefix: string): { num: number; name: string; runDir: string } {
  const runsDir = getRunsDir();
  let num = getNextLogNum(prefix);

  for (;;) {
    const name = `${prefix}-${num}`;
    const runDir = path.join(runsDir, name);
    try {
      fs.mkdirSync(runDir);
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

  let logDir = path.join(runDir, "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error: unknown) {
    if (!preferredName || !isPermissionError(error)) {
      throw error;
    }
    ({ num, name, runDir } = allocateRunDir(prefix));
    logDir = path.join(runDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
  }

  return {
    num,
    name,
    runDir,
    logDir,
    outputLogPath: path.join(logDir, "output.log"),
    debugLogPath: path.join(logDir, "debug.log"),
  };
}

export type LogContext = ReturnType<typeof createLogContext>;
