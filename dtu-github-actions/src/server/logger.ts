import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DTU_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
let dtuLogsDir = process.env.DTU_LOGS_DIR ?? path.join(DTU_ROOT, "_", "logs");
let dtuLogPath = path.join(dtuLogsDir, "dtu-server.log");

export function setWorkingDirectory(dir: string): void {
  dtuLogsDir = path.join(dir, "logs");
  dtuLogPath = path.join(dtuLogsDir, "dtu-server.log");
}

export function getDtuLogPath(): string {
  return dtuLogPath;
}

let logStream: fs.WriteStream | null = null;

const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origError = console.error.bind(console);

export function setupDtuLogging() {
  fs.mkdirSync(dtuLogsDir, { recursive: true });
  logStream = fs.createWriteStream(dtuLogPath, { flags: "a" });

  console.log = (...args: unknown[]) => {
    _origLog(...args);
    writeToLog(...args);
  };

  console.warn = (...args: unknown[]) => {
    _origWarn(...args);
    writeToLog("[WARN]", ...args);
  };

  console.error = (...args: unknown[]) => {
    _origError(...args);
    writeToLog("[ERROR]", ...args);
  };
}

function writeToLog(...args: unknown[]): void {
  if (!logStream) {
    return;
  }
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logStream.write(`${new Date().toISOString()} ${line}\n`);
}
