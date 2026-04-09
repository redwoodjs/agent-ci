import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerSocket } from "../docker/docker-socket.js";

const dockerCtor = vi.fn();

vi.mock("dockerode", () => ({
  default: dockerCtor,
}));

vi.mock("dtu-github-actions/ephemeral", () => ({
  startEphemeralDtu: vi.fn(),
}));

afterEach(() => {
  dockerCtor.mockReset();
});

describe("getDocker client construction", () => {
  it("uses socketPath for unix sockets", async () => {
    const mod = await import("./local-job.js");
    const socket: DockerSocket = {
      socketPath: "/tmp/docker.sock",
      uri: "unix:///tmp/docker.sock",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith({ socketPath: "/tmp/docker.sock" });
  });

  it("uses ssh transport for ssh URIs", async () => {
    const mod = await import("./local-job.js");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "ssh://user@remote-host",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith({
      host: "ssh://user@remote-host",
      protocol: "ssh",
    });
  });

  it("falls back to dockerode environment parsing for tcp URIs", async () => {
    const mod = await import("./local-job.js");
    const socket: DockerSocket = {
      socketPath: "",
      uri: "tcp://192.168.110.1:2375",
    };

    mod.__test_createDockerClient(socket);

    expect(dockerCtor).toHaveBeenCalledWith();
  });
});
