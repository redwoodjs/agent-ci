import fs from "node:fs";
import path from "node:path";

let logRoot: string | null = null;

export function getLogRoot() {
  if (!logRoot) {
    throw new Error("Log root not set");
  }
  return logRoot;
}

export function setLogRoot(root: string) {
  logRoot = root;
}

function getRunsDir() {
  const runsDir = path.join(getLogRoot(), "runs");
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }
  return runsDir;
}

function ensureLogDirs() {
  const root = getLogRoot();
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
}

function getNextLogNum(prefix: string): number {
  const runsDir = getRunsDir();
  const entries = fs.readdirSync(runsDir, { withFileTypes: true });
  const nums = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(`${prefix}-`))
    .map((e) => {
      const n = parseInt(e.name.slice(prefix.length + 1), 10);
      return Number.isNaN(n) ? 0 : n;
    })
    .filter((n) => n > 0);

  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  return maybeCode === "EACCES" || maybeCode === "EPERM";
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

  let logDir = path.join(runDir, "logs");
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (error: unknown) {
    if (!preferredName || !isPermissionError(error)) {
      throw error;
    }
    num = getNextLogNum(prefix);
    name = `${prefix}-${num}`;
    runDir = path.join(getRunsDir(), name);
    logDir = path.join(runDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
  }

  return {
    num,
    name,
    runDir,
    logDir,
    stepJsonPath: path.join(runDir, "steps.json") as `${string}/steps.json`,
    getStepLogPath: (stepName: string) =>
      path.join(logDir, `${stepName}.txt`) as `${string}/${string}.txt`,
  };
}

export type LogContext = ReturnType<typeof createLogContext>;
