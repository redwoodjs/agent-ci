import { describe, expect, it } from "vitest";
import { resolveContainerHostForEnv } from "./ephemeral.ts";

describe("resolveContainerHostForEnv", () => {
  it("uses configured DTU host outside Docker", () => {
    expect(
      resolveContainerHostForEnv({
        configuredHost: "10.1.0.1",
        isInsideDocker: false,
      }),
    ).toBe("10.1.0.1");
  });

  it("uses this container's IP inside Docker instead of inherited DTU host", () => {
    expect(
      resolveContainerHostForEnv({
        configuredHost: "host.docker.internal",
        containerIp: "172.18.0.4",
        isInsideDocker: true,
      }),
    ).toBe("172.18.0.4");
  });

  it("falls back to bridge gateway inside Docker when the container IP is unavailable", () => {
    expect(
      resolveContainerHostForEnv({
        configuredHost: "host.docker.internal",
        bridgeGateway: "172.19.0.1",
        isInsideDocker: true,
      }),
    ).toBe("172.19.0.1");
  });
});
