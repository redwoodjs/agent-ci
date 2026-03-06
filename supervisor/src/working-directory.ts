import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Pinned to the monorepo root (project root), not the supervisor package
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Define the default working directory globally: /tmp/machinen/<repo>
export const DEFAULT_WORKING_DIR = path.join(os.tmpdir(), "machinen", path.basename(PROJECT_ROOT));

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
