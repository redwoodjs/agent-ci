import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Pinned to the monorepo root (project root), not the cli package
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// When running inside a container with Docker-outside-of-Docker (shared socket),
// /tmp is NOT visible to the Docker host. Use a project-relative directory
// so bind mounts resolve correctly on the host.
const isInsideDocker = fs.existsSync("/.dockerenv");
export const DEFAULT_WORKING_DIR = isInsideDocker
  ? path.join(PROJECT_ROOT, ".agent-ci")
  : path.join(os.tmpdir(), "agent-ci", path.basename(PROJECT_ROOT));

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
