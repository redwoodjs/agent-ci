import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockedExecSync = vi.mocked(execSync);

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_HOST;
});

// Helper to dynamically import (fresh module each test via vi.resetModules)
async function importFresh() {
  vi.resetModules();
  return import("./docker-socket.js");
}

describe("resolveDockerSocket", () => {
  // ── DOCKER_HOST set ──────────────────────────────────────────────────────

  it("uses DOCKER_HOST when set to a unix socket that exists", async () => {
    process.env.DOCKER_HOST = "unix:///tmp/test-docker.sock";
    vi.spyOn(fs, "realpathSync").mockReturnValue("/tmp/test-docker.sock");
    vi.spyOn(fs, "accessSync").mockReturnValue(undefined);

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/tmp/test-docker.sock");
    expect(result.uri).toBe("unix:///tmp/test-docker.sock");
  });

  it("returns non-unix DOCKER_HOST as-is (e.g. ssh://)", async () => {
    process.env.DOCKER_HOST = "ssh://user@remote";

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("");
    expect(result.uri).toBe("ssh://user@remote");
  });

  // ── Default socket path ────────────────────────────────────────────────

  it("resolves /var/run/docker.sock symlink", async () => {
    delete process.env.DOCKER_HOST;
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
  });

  // ── EACCES fallthrough ─────────────────────────────────────────────────

  it("falls through to docker context when default socket is not accessible", async () => {
    delete process.env.DOCKER_HOST;
    // Socket exists but is not accessible (e.g. root:docker 660 on Linux)
    vi.spyOn(fs, "realpathSync").mockReturnValue("/var/run/docker.sock");
    vi.spyOn(fs, "accessSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === "/home/user/.docker/desktop/docker.sock";
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

    expect(result.socketPath).toBe("/home/user/.docker/desktop/docker.sock");
  });

  // ── Docker context fallback ─────────────────────────────────────────────

  it("falls back to docker context inspect when default socket missing", async () => {
    delete process.env.DOCKER_HOST;
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === "/Users/test/.docker/run/docker.sock";
    });
    mockedExecSync.mockReturnValue(
      JSON.stringify([
        {
          Endpoints: {
            docker: { Host: "unix:///Users/test/.docker/run/docker.sock" },
          },
        },
      ]),
    );

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe("/Users/test/.docker/run/docker.sock");
  });

  // ── macOS provider fallback ──────────────────────────────────────────────

  it("checks well-known macOS provider sockets when context fails", async () => {
    delete process.env.DOCKER_HOST;
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    mockedExecSync.mockImplementation(() => {
      throw new Error("docker not found");
    });
    const home = os.homedir();
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p) === `${home}/.docker/run/docker.sock`;
    });
    // Ensure we're on darwin for this path
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const { resolveDockerSocket } = await importFresh();
    const result = resolveDockerSocket();

    expect(result.socketPath).toBe(`${home}/.docker/run/docker.sock`);
  });

  // ── Reproduction: symlink missing → clear error ─────────────────────────

  it("throws with actionable error when no socket is found", async () => {
    delete process.env.DOCKER_HOST;
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockedExecSync.mockImplementation(() => {
      throw new Error("docker not found");
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow("Could not find a Docker socket");
    expect(() => resolveDockerSocket()).toThrow("DOCKER_HOST");
    expect(() => resolveDockerSocket()).toThrow("ln -s");
  });

  it("falls through when DOCKER_HOST points to non-existent socket", async () => {
    process.env.DOCKER_HOST = "unix:///nonexistent/docker.sock";
    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw new Error("ENOENT");
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    mockedExecSync.mockImplementation(() => {
      throw new Error("docker not found");
    });
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const { resolveDockerSocket } = await importFresh();

    expect(() => resolveDockerSocket()).toThrow("Could not find a Docker socket");
  });
});
