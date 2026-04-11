import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pinned to the cli package root
export const PROJECT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// When running inside a container with Docker-outside-of-Docker (shared socket),
// /tmp is NOT visible to the Docker host. Use a project-relative directory
// so bind mounts resolve correctly on the host.
const isInsideDocker = fs.existsSync("/.dockerenv");

function isDockerDesktop(): boolean {
  try {
    const json = execSync("docker context inspect", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const data = JSON.parse(json);
    const host: string = data?.[0]?.Endpoints?.docker?.Host ?? "";
    return host.includes(".docker/desktop/") || host.includes(".docker/run/");
  } catch {
    return false;
  }
}

function resolveDefaultWorkDir(): string {
  if (isInsideDocker) {
    return path.join(PROJECT_ROOT, ".agent-ci");
  }
  // Docker Desktop on macOS/Linux cannot mount paths under /tmp.
  // Use a project-relative directory so bind mounts work.
  if (isDockerDesktop()) {
    return path.join(process.cwd(), ".agent-ci");
  }
  return path.join(os.tmpdir(), "agent-ci", path.basename(PROJECT_ROOT));
}

export const DEFAULT_WORKING_DIR = resolveDefaultWorkDir();

let workingDirectory = DEFAULT_WORKING_DIR;

export function setWorkingDirectory(dir: string): void {
  workingDirectory = dir;
}

export function getWorkingDirectory(): string {
  return workingDirectory;
}
