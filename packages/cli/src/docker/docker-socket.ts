import fs from "fs";
import { execSync } from "child_process";
import { debugRunner } from "../output/debug.js";

const DEFAULT_SOCKET = "/var/run/docker.sock";
const DOCS_URL =
  "https://github.com/redwoodjs/agent-ci/blob/main/packages/cli/docs/docker-socket.md";

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
 *     the Docker socket into a runner container. Docker's mount subsystem
 *     (on macOS through the VM, on Linux directly) validates this path against
 *     its shared-mount list. Our process's permissions are irrelevant here —
 *     only path recognition matters.
 *
 * The bind-mount invariant: unless the user has set DOCKER_HOST explicitly,
 * `/var/run/docker.sock` must exist and be the bind-mount source. Every Docker
 * provider either creates it directly (Docker Desktop, native dockerd) or can
 * be pointed at it via a symlink (OrbStack does this automatically; Colima is
 * a manual `ln -sf`). We refuse to guess provider-specific paths — those tend
 * to fail later at bind-mount time with confusing errors (#197, #209, #263).
 *
 * Resolution order:
 *  1. `DOCKER_HOST` env var wins outright (local paths validated; non-unix
 *     schemes returned as-is).
 *  2. `/var/run/docker.sock` must exist. If we can R/W it, its resolved path
 *     is the API `socketPath`; otherwise we look up the active docker context
 *     to find a readable path (#209), but `bindMountPath` stays as
 *     `/var/run/docker.sock`.
 *  3. Neither → throw with a doc link.
 */
export function resolveDockerSocket(): DockerSocket {
  // 1. Explicit DOCKER_HOST wins.
  const envHost = process.env.DOCKER_HOST?.trim();
  if (envHost) {
    if (!envHost.startsWith("unix://")) {
      // Non-unix scheme (ssh://, tcp://) — container bind-mount is out of scope.
      return { socketPath: "", uri: envHost, bindMountPath: "" };
    }
    const socketPath = envHost.replace("unix://", "");
    const resolved = resolveIfExists(socketPath);
    if (resolved) {
      return { socketPath: resolved, uri: `unix://${resolved}`, bindMountPath: socketPath };
    }
    throw unusableSocketError(`DOCKER_HOST=${envHost} does not resolve to a working socket.`);
  }

  // 2. /var/run/docker.sock must exist. existsSync returns false for dangling
  //    symlinks, which is exactly the case we want to reject (stale provider state).
  if (!fs.existsSync(DEFAULT_SOCKET)) {
    throw unusableSocketError(`${DEFAULT_SOCKET} is missing or a dangling symlink.`);
  }

  // Happy path: we can R/W the socket directly.
  const defaultResolved = resolveIfExists(DEFAULT_SOCKET);
  if (defaultResolved) {
    return {
      socketPath: defaultResolved,
      uri: `unix://${defaultResolved}`,
      bindMountPath: DEFAULT_SOCKET,
    };
  }

  // The socket exists but we can't R/W it. Linux + Docker Desktop with user
  // outside the `docker` group is the canonical case (#209) — the active
  // docker context tells us a path we *can* read, but we still bind-mount
  // /var/run/docker.sock because that's what the mount layer accepts.
  const contextSocket = socketFromDockerContext();
  if (contextSocket) {
    return {
      socketPath: contextSocket,
      uri: `unix://${contextSocket}`,
      bindMountPath: DEFAULT_SOCKET,
    };
  }

  throw unusableSocketError(
    `${DEFAULT_SOCKET} exists but is not readable, and no active docker context provides an alternative.`,
  );
}

function unusableSocketError(detail: string): Error {
  return new Error(
    [
      `agent-ci couldn't use a Docker socket at /var/run/docker.sock.`,
      detail,
      ``,
      `A working Docker socket is required there (or set DOCKER_HOST explicitly).`,
      `See: ${DOCS_URL}`,
    ].join("\n"),
  );
}

/**
 * If `socketPath` exists (following symlinks) and is accessible, return the
 * real path.  Returns undefined otherwise so the caller can keep searching.
 */
function resolveIfExists(socketPath: string): string | undefined {
  try {
    const resolved = fs.realpathSync(socketPath);
    fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
    return resolved;
  } catch {
    return undefined;
  }
}
