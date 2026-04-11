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
  /** Filesystem path to the socket (no unix:// prefix), with symlinks resolved. Used for the Docker API client. */
  socketPath: string;
  /** Full URI suitable for DOCKER_HOST (e.g. "unix:///path/to/socket"). */
  uri: string;
  /**
   * Path to use as the bind-mount source when mounting the Docker socket into a container.
   *
   * Unlike `socketPath`, this is the pre-symlink-resolution path (e.g. `/var/run/docker.sock`)
   * so that Docker on macOS can access it through its VM without failing with
   * "error while creating mount source path".
   */
  bindMountPath: string;
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
        // Use the original DOCKER_HOST path for bind mounts, not the resolved one.
        // On macOS, Docker's VM may not be able to access the resolved path directly.
        return { socketPath: resolved, uri: `unix://${resolved}`, bindMountPath: socketPath };
      }
      // The env var points to a non-existent socket — fall through to auto-detect
      debugRunner(`DOCKER_HOST=${envHost} does not exist, trying auto-detection`);
    } else {
      // Non-unix scheme (ssh://, tcp://, etc.) — cannot resolve a local path
      // Return a sentinel; callers handle non-unix hosts separately.
      return { socketPath: "", uri: envHost, bindMountPath: "" };
    }
  }

  // 2. Default socket path (often a symlink on macOS)
  const defaultResolved = resolveIfExists(DEFAULT_SOCKET);
  if (defaultResolved) {
    // Always use DEFAULT_SOCKET as the bind-mount path, even if it resolves to a
    // different location. On macOS Docker Desktop, /var/run/docker.sock is a symlink
    // to a path inside the user's home directory; using the resolved path as a bind
    // mount source causes "error while creating mount source path" because Docker's
    // VM cannot access that host path.
    return {
      socketPath: defaultResolved,
      uri: `unix://${defaultResolved}`,
      bindMountPath: DEFAULT_SOCKET,
    };
  }

  // 3. Docker context
  const contextSocket = socketFromDockerContext();
  if (contextSocket) {
    // The context socket works for API calls but may not be bind-mountable
    // (e.g. Docker Desktop's ~/.docker/desktop/docker.sock on Linux).
    // For bind mounts, prefer the default socket if it exists on disk — the
    // container runs as root so the daemon-side permission check succeeds
    // even when this process cannot read the socket directly.
    const bindMountPath = socketExistsOnDisk(DEFAULT_SOCKET)
      ? DEFAULT_SOCKET
      : contextSocket;
    return {
      socketPath: contextSocket,
      uri: `unix://${contextSocket}`,
      bindMountPath,
    };
  }

  // 4. Well-known macOS provider paths
  if (process.platform === "darwin") {
    for (const candidate of MACOS_PROVIDER_SOCKETS) {
      if (fs.existsSync(candidate)) {
        return { socketPath: candidate, uri: `unix://${candidate}`, bindMountPath: candidate };
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

/**
 * Check if a socket path exists on disk without verifying R_OK|W_OK permissions.
 * Used to determine if the default socket can be used as a bind-mount source
 * even when this process lacks direct access (e.g. user not in docker group).
 */
function socketExistsOnDisk(socketPath: string): boolean {
  try {
    fs.realpathSync(socketPath);
    return true;
  } catch {
    return false;
  }
}
