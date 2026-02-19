import path from "path";
import fs from "fs";

export const LOGS_DIR = path.resolve(process.cwd(), "_", "logs");
export const PENDING_LOGS_DIR = path.join(LOGS_DIR, "pending");
export const IN_PROGRESS_LOGS_DIR = path.join(LOGS_DIR, "in-progress");
export const COMPLETED_LOGS_DIR = path.join(LOGS_DIR, "completed");
export const DEBUG_LOGS_DIR = path.join(LOGS_DIR, "debug");

export function getTimestamp(): string {
  const now = new Date();
  const YYYY = now.getFullYear();
  const MM = String(now.getMonth() + 1).padStart(2, "0");
  const DD = String(now.getDate()).padStart(2, "0");
  const HH = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${YYYY}${MM}${DD}-${HH}${mm}`;
}

export function ensureLogDirs(): void {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  if (!fs.existsSync(PENDING_LOGS_DIR)) fs.mkdirSync(PENDING_LOGS_DIR, { recursive: true });
  if (!fs.existsSync(IN_PROGRESS_LOGS_DIR)) fs.mkdirSync(IN_PROGRESS_LOGS_DIR, { recursive: true });
  if (!fs.existsSync(COMPLETED_LOGS_DIR)) fs.mkdirSync(COMPLETED_LOGS_DIR, { recursive: true });
  if (!fs.existsSync(DEBUG_LOGS_DIR)) fs.mkdirSync(DEBUG_LOGS_DIR, { recursive: true });
}

export function finalizeLog(logPath: string, exitCode: number, commitSha?: string): string {
  ensureLogDirs(); // Just in case
  const basename = path.basename(logPath, ".log"); // e.g. "20260218-1821-runner"
  const finalFilename = `${basename}-${exitCode}.log`;
  
  let targetDir = COMPLETED_LOGS_DIR;
  if (commitSha && commitSha !== "unknown") {
    targetDir = path.join(COMPLETED_LOGS_DIR, commitSha);
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  }

  const finalPath = path.join(targetDir, finalFilename);

  try {
    fs.renameSync(logPath, finalPath);
    return finalPath;
  } catch (err) {
    console.error(`[Logger] Failed to finalize log file:`, err);
    return logPath;
  }
}
