import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { debugRunner } from "../output/debug.js";

const DEFAULT_SOCKET = "/var/run/docker.sock";

/**
 * Well-known Docker socket paths on macOS, checked in order.
 * Linux distros almost always have /var/run/docker.sock directly.
 */
const MACOS_PROVIDER_SOCKETS = [
  path.join(os.homedir(), ".orbstack/run/docker.sock"),
  path.join(os.homedir(), ".docker/run/docker.sock"),
  path.join(os.homedir(), ".colima/default/docker.sock"),
  path.join(os.homedir(), ".lima/docker/sock/docker.sock"),
];

/**
 * Try to extract the socket path from the active Docker context.
 * Returns undefined if the command fails or the context uses a non-unix endpoint.
 */
function socketFromDockerContext(): string | undefined {
  try {
    const json = execSync("docker context inspect", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    const data = JSON.parse(json);
    const host: string | undefined = data?.[0]?.Endpoints?.docker?.Host;
    if (host && host.startsWith("unix://")) {
      const socketPath = host.replace("unix://", "");
      if (fs.existsSync(socketPath)) {
        return socketPath;
      }
      debugRunner(`Docker context points to ${socketPath} but it does not exist`);
    }
  } catch {
    debugRunner("Could not inspect Docker context");
  }
  return undefined;
}

export interface DockerSocket {
  /** Filesystem path to the socket (no unix:// prefix). */
  socketPath: string;
  /** Full URI suitable for DOCKER_HOST (e.g. "unix:///path/to/socket"). */
  uri: string;
}

/**
 * Resolve the Docker daemon socket.
 *
 * Resolution order:
 *  1. `DOCKER_HOST` env var (returned as-is for non-unix schemes)
 *  2. Default socket `/var/run/docker.sock` (resolves symlinks)
 *  3. Active Docker context (`docker context inspect`)
 *  4. Well-known macOS provider sockets
 *
 * Throws with actionable guidance when no socket can be found.
 */
export function resolveDockerSocket(): DockerSocket {
  // 1. Explicit DOCKER_HOST
  const envHost = process.env.DOCKER_HOST?.trim();
  if (envHost) {
    if (envHost.startsWith("unix://")) {
      const socketPath = envHost.replace("unix://", "");
      const resolved = resolveIfExists(socketPath);
      if (resolved) {
        return { socketPath: resolved, uri: `unix://${resolved}` };
      }
      // The env var points to a non-existent socket — fall through to auto-detect
      debugRunner(`DOCKER_HOST=${envHost} does not exist, trying auto-detection`);
    } else {
      // Non-unix scheme (ssh://, tcp://, etc.) — cannot resolve a local path
      // Return a sentinel; callers handle non-unix hosts separately.
      return { socketPath: "", uri: envHost };
    }
  }

  // 2. Default socket path (often a symlink on macOS)
  const defaultResolved = resolveIfExists(DEFAULT_SOCKET);
  if (defaultResolved) {
    return { socketPath: defaultResolved, uri: `unix://${defaultResolved}` };
  }

  // 3. Docker context
  const contextSocket = socketFromDockerContext();
  if (contextSocket) {
    return { socketPath: contextSocket, uri: `unix://${contextSocket}` };
  }

  // 4. Well-known macOS provider paths
  if (process.platform === "darwin") {
    for (const candidate of MACOS_PROVIDER_SOCKETS) {
      if (fs.existsSync(candidate)) {
        return { socketPath: candidate, uri: `unix://${candidate}` };
      }
    }
  }

  // Nothing found — give the user actionable guidance
  const searched = [
    DEFAULT_SOCKET,
    ...(process.platform === "darwin" ? MACOS_PROVIDER_SOCKETS : []),
  ];
  const lines = [
    "Could not find a Docker socket. Searched:",
    ...searched.map((p) => `  - ${p}`),
    "",
    "To fix this, either:",
    "  • Set the DOCKER_HOST environment variable (e.g. DOCKER_HOST=unix:///path/to/docker.sock)",
    `  • Create a symlink:  ln -s /path/to/docker.sock ${DEFAULT_SOCKET}`,
    "  • Start your Docker provider (Docker Desktop, OrbStack, Colima, etc.)",
  ];
  throw new Error(lines.join("\n"));
}

/**
 * If `socketPath` exists (following symlinks) and is accessible, return the
 * real path.  Returns undefined otherwise so the caller can keep searching.
 */
function resolveIfExists(socketPath: string): string | undefined {
  try {
    // fs.realpathSync follows symlinks and throws if the target doesn't exist
    const resolved = fs.realpathSync(socketPath);
    // Verify we can actually connect — the socket may exist but be owned by
    // root:docker with 660 perms (common on Linux with Docker Desktop).
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return resolved;
  } catch {
    return undefined;
  }
}
