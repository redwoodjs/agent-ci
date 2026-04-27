import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_CI_DOCKER_HOST;
});

async function importFresh() {
  vi.resetModules();
  return import("./docker-socket.js");
}

describe("resolveDockerSocket", () => {
  // ── AGENT_CI_DOCKER_HOST set ──────────────────────────────────────────────────────

  it("uses AGENT_CI_DOCKER_HOST when set to a unix socket that exists", async () => {
    process.env.AGENT_CI_DOCKER_HOST = "unix:///tmp/test-docker.sock";
    vi.spyOn(fs, "realpathSync").mockReturnValue("/tmp/test-docker.sock");
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/tmp/test-docker.sock");
    expect(result.uri).toBe("unix:///tmp/test-docker.sock");
    expect(result.bindMountPath).toBe("/tmp/test-docker.sock");
  });

  it("uses original AGENT_CI_DOCKER_HOST path as bindMountPath even when it resolves elsewhere", async () => {
    process.env.AGENT_CI_DOCKER_HOST = "unix:///var/run/docker.sock";
    vi.spyOn(fs, "realpathSync").mockReturnValue("/Users/test/.docker/run/docker.sock");
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/Users/test/.docker/run/docker.sock");
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  it("returns non-unix AGENT_CI_DOCKER_HOST as-is (e.g. ssh://)", async () => {
    process.env.AGENT_CI_DOCKER_HOST = "ssh://user@remote";

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("");
    expect(result.uri).toBe("ssh://user@remote");
    expect(result.bindMountPath).toBe("");
  });

  it("throws with doc link when AGENT_CI_DOCKER_HOST points to non-existent socket", async () => {
    process.env.AGENT_CI_DOCKER_HOST = "unix:///nonexistent/docker.sock";
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow(
      "AGENT_CI_DOCKER_HOST=unix:///nonexistent/docker.sock",
    );
    expect(() => resolveDockerSocket()).toThrow("docs/docker-socket.md");
  });

  // ── Default socket path ────────────────────────────────────────────────

  it("resolves /var/run/docker.sock symlink", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "realpathSync").mockImplementation((p) => {
      if (String(p) === "/var/run/docker.sock") {
        return "/Users/test/.orbstack/run/docker.sock";
      }
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/Users/test/.orbstack/run/docker.sock");
    expect(result.uri).toBe("unix:///Users/test/.orbstack/run/docker.sock");
    // bindMountPath must stay as /var/run/docker.sock (the symlink), not the resolved path.
    // Using the resolved path as a bind-mount source fails on macOS Docker Desktop with
    // "error while creating mount source path" (issue #197).
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  it("uses /var/run/docker.sock as bindMountPath when it resolves to Docker Desktop path (regression #197)", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "realpathSync").mockImplementation((p) => {
      if (String(p) === "/var/run/docker.sock") {
        return "/Users/username/.docker/run/docker.sock";
      }
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/Users/username/.docker/run/docker.sock");
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  // ── EACCES fallthrough ─────────────────────────────────────────────────

  it("falls through to docker context when default socket is not accessible, and uses /var/run/docker.sock for bind mount (regression #209)", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    // Exact #209 cell: Linux + Docker Desktop, user not in docker group.
    // - /var/run/docker.sock exists (owned by root:docker 660) — exists but EACCES for us
    // - Active docker context points at the Desktop socket — what our API client must use
    // - Bind mount must NOT be the Desktop socket (Docker Desktop rejects its own socket
    //   path as a mount source with "mounts denied") — it must be /var/run/docker.sock,
    //   which Docker Desktop's mount proxy accepts.
    vi.spyOn(fs, "realpathSync").mockReturnValue("/var/run/docker.sock");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      return s === "/var/run/docker.sock" || s === "/home/user/.docker/desktop/docker.sock";
    });
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          Endpoints: {
            docker: {
              Host: "unix:///home/user/.docker/desktop/docker.sock",
            },
          },
        },
      ]),
    );

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    // API client connects via the Desktop socket (we can't R/W /var/run/docker.sock)
    expect(result.socketPath).toBe("/home/user/.docker/desktop/docker.sock");
    // Bind mount uses /var/run/docker.sock — the path Docker Desktop's mount proxy accepts
    expect(result.bindMountPath).toBe("/var/run/docker.sock");
  });

  // ── Missing / dangling /var/run/docker.sock ─────────────────────────────

  it("throws with doc link when /var/run/docker.sock is missing", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow("/var/run/docker.sock");
    expect(() => resolveDockerSocket()).toThrow("missing or a dangling symlink");
    expect(() => resolveDockerSocket()).toThrow("docs/docker-socket.md");
  });

  it("appends Docker Desktop toggle hint when ~/.docker/run/docker.sock exists but /var/run/docker.sock is missing", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      if (s === "/var/run/docker.sock") {
        return false;
      }
      if (s.endsWith("/.docker/run/docker.sock")) {
        return true;
      }
      return false;
    });
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow(
      "Docker Desktop is running but the default socket is disabled",
    );
    expect(() => resolveDockerSocket()).toThrow("Settings → Advanced");
  });

  it("throws with doc link when /var/run/docker.sock is a dangling symlink (stale OrbStack / Colima switch)", async () => {
    // Regression for #263 debugging session: /var/run/docker.sock → ~/.orbstack/...
    // but OrbStack is stopped, so the link dangles. fs.existsSync returns false for
    // dangling symlinks, which is the signal we want.
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow("dangling symlink");
  });

  it("throws with doc link when /var/run/docker.sock exists but EACCES and no readable context", async () => {
    delete process.env.AGENT_CI_DOCKER_HOST;
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "realpathSync").mockReturnValue("/var/run/docker.sock");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    mockedExecSync.mockImplementation(() => {
      throw new Error("docker not found");
    });

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow("not readable");
    expect(() => resolveDockerSocket()).toThrow("docs/docker-socket.md");
  });
});
