import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// Pinned to the cli package root
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// When running inside a container with Docker-outside-of-Docker (shared socket),
// /tmp is NOT visible to the Docker host. Use a project-relative directory
// so bind mounts resolve correctly on the host.
const isInsideDocker = fs.existsSync("/.dockerenv");

function resolveDefaultWorkDir(): string {
  if (isInsideDocker) {
    return path.join(PROJECT_ROOT, ".agent-ci");
  }
  // Always use a cwd-relative directory so bind mounts work regardless of
  // the Docker provider. /tmp is not mountable on Docker Desktop (macOS/Linux)
  // and other providers may have similar restrictions.
  return path.join(process.cwd(), ".agent-ci");
}

export const DEFAULT_WORKING_DIR = resolveDefaultWorkDir();

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
