import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Pinned to the cli package root
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Use a persistent directory in the user's home directory by default.
// This avoids disk space issues with /tmp and allows reuse of installed
// dependencies between runs. Falls back to project-relative when running
// inside Docker (Docker-outside-of-Docker with shared socket).
const isInsideDocker = fs.existsSync("/.dockerenv");
export const DEFAULT_WORKING_DIR = isInsideDocker
  ? path.join(PROJECT_ROOT, ".agent-ci")
  : path.join(os.homedir(), ".agent-ci", path.basename(PROJECT_ROOT));

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
