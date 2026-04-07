/**
 * Reproduction for https://github.com/redwoodjs/agent-ci/issues/126
 *
 * When running inside Docker (via agent-ci), AGENT_CI_DTU_HOST is set in the
 * container environment. The resolveDtuHost tests delete it, but this test
 * verifies the mock and env var interaction actually works in that scenario.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue-126 reproduction: resolveDtuHost inside Docker", () => {
  const originalBridgeGateway = process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY;
  const originalDtuHost = process.env.AGENT_CI_DTU_HOST;

  beforeEach(() => {
    delete process.env.AGENT_CI_DTU_HOST;
  });

  afterEach(() => {
    if (originalBridgeGateway === undefined) {
      delete process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY;
    } else {
      process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY = originalBridgeGateway;
    }
    if (originalDtuHost === undefined) {
      delete process.env.AGENT_CI_DTU_HOST;
    } else {
      process.env.AGENT_CI_DTU_HOST = originalDtuHost;
    }
  });

  it("reports environment state", async () => {
    console.log("--- issue-126 repro diagnostics ---");
    console.log("/.dockerenv exists:", fs.existsSync("/.dockerenv"));
    console.log("AGENT_CI_DTU_HOST:", process.env.AGENT_CI_DTU_HOST ?? "(unset)");
    console.log(
      "AGENT_CI_DOCKER_BRIDGE_GATEWAY:",
      process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY ?? "(unset)",
    );
    expect(true).toBe(true);
  });

  it("mock fs.existsSync intercepts /.dockerenv check", async () => {
    const realResult = fs.existsSync("/.dockerenv");
    console.log("Real fs.existsSync('/.dockerenv'):", realResult);

    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      if (filePath === "/.dockerenv") {
        return false;
      }
      return originalExistsSync(filePath);
    });

    const mockedResult = fs.existsSync("/.dockerenv");
    console.log("Mocked fs.existsSync('/.dockerenv'):", mockedResult);
    expect(mockedResult).toBe(false);
  });

  it("resolveDtuHost uses bridge gateway when mock is active (the failing test)", async () => {
    // Simulate agent-ci Docker env: AGENT_CI_DTU_HOST was set but we deleted it
    delete process.env.AGENT_CI_DTU_HOST;

    const { resolveDtuHost } = await import("./container-config.js");

    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((filePath: fs.PathLike) => {
      if (filePath === "/.dockerenv") {
        return false;
      }
      return originalExistsSync(filePath);
    });
    process.env.AGENT_CI_DOCKER_BRIDGE_GATEWAY = "10.10.0.1";

    // This is the assertion that was failing: expected '10.10.0.1' but got 'host.docker.internal'
    const result = await resolveDtuHost();
    console.log("resolveDtuHost() returned:", result);
    console.log("Expected: 10.10.0.1");
    expect(result).toBe("10.10.0.1");
  });
});
