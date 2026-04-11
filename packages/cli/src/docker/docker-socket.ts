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
   * Unlike `socketPath`, this is the pre-symlink-resolution path (e.g. `/var/run/docker.sock`)
   * so that Docker on macOS can access it through its VM without failing with
   * "error while creating mount source path".
   */
  bindMountPath: string;
}

/**
 * Resolve the Docker daemon socket.
 *
 * Two decisions with different requirements:
 *   - `socketPath` — what our Node process opens for the Docker API client.
 *     Needs R/W access from our UID.
 *   - `bindMountPath` — what we pass as the bind-mount *source* when mounting
 *     the Docker socket into a runner container. Docker's VM (on macOS + Linux
 *     Docker Desktop) validates this path against its shared-mount list. Our
 *     process's permissions are irrelevant here — only path recognition matters.
 *
 * Invariant: whenever `/var/run/docker.sock` exists on the host, use it as
 * `bindMountPath` regardless of R/W access. Every Docker provider we've seen
 * (Docker Desktop mac + Linux, OrbStack, Colima, native dockerd) either creates
 * it directly or symlinks to it, and Docker Desktop's mount proxy accepts it.
 * This collapses the macOS Desktop symlink case (#197) and the Linux Desktop +
 * non-docker-group case (#209) into one rule.
 *
 * Resolution order for `socketPath`:
 *  1. `DOCKER_HOST` env var (returned as-is for non-unix schemes)
 *  2. Default socket `/var/run/docker.sock` (resolves symlinks, requires R/W)
 *  3. Active Docker context (`docker context inspect`)
 *  4. Well-known macOS provider sockets
 *
 * Throws with actionable guidance when no socket can be found.
 */
export function resolveDockerSocket(): DockerSocket {
  // `/var/run/docker.sock` existence check is independent of R/W access —
  // `existsSync` only needs search permission on `/var/run`, which is always granted.
  const mountableDefault = fs.existsSync(DEFAULT_SOCKET) ? DEFAULT_SOCKET : undefined;

  // 1. Explicit DOCKER_HOST — user's explicit choice wins for bindMountPath too.
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
    return {
      socketPath: defaultResolved,
      uri: `unix://${defaultResolved}`,
      bindMountPath: DEFAULT_SOCKET,
    };
  }

  // 3. Docker context
  const contextSocket = socketFromDockerContext();
  if (contextSocket) {
    return {
      socketPath: contextSocket,
      uri: `unix://${contextSocket}`,
      bindMountPath: mountableDefault ?? contextSocket,
    };
  }

  // 4. Well-known macOS provider paths
  if (process.platform === "darwin") {
    for (const candidate of MACOS_PROVIDER_SOCKETS) {
      if (fs.existsSync(candidate)) {
        return {
          socketPath: candidate,
          uri: `unix://${candidate}`,
          bindMountPath: mountableDefault ?? candidate,
        };
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
