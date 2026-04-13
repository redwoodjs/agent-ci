import { describe, expect, it } from "vitest";
import {
  collectJobResourceHints,
  classifyJobResources,
  type HostResources,
  parseNodeMaxOldSpaceMb,
  parseRequestedCpuCount,
} from "./resource-classifier.js";

describe("parseRequestedCpuCount", () => {
  it("parses explicit larger-runner labels ending in -cores", () => {
    expect(parseRequestedCpuCount(["ubuntu-latest-8-cores"])).toBe(8);
  });

  it("ignores generic runner labels", () => {
    expect(parseRequestedCpuCount(["ubuntu-latest"])).toBeUndefined();
  });

  it("ignores mixed labels without an explicit -cores suffix", () => {
    expect(parseRequestedCpuCount(["self-hosted", "linux", "x64"])).toBeUndefined();
  });
});

describe("parseNodeMaxOldSpaceMb", () => {
  it("uses the last max-old-space-size flag", () => {
    expect(
      parseNodeMaxOldSpaceMb({
        NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings --max-old-space-size=8192",
      }),
    ).toBe(8192);
  });

  it("ignores unrelated NODE_OPTIONS flags", () => {
    expect(
      parseNodeMaxOldSpaceMb({ NODE_OPTIONS: "--no-network-family-autoselection" }),
    ).toBeUndefined();
  });

  it("returns undefined when NODE_OPTIONS is missing", () => {
    expect(parseNodeMaxOldSpaceMb({})).toBeUndefined();
  });
});

describe("collectJobResourceHints", () => {
  it("packages workflow accessors into a hint object", () => {
    expect(
      collectJobResourceHints({
        labels: ["ubuntu-latest-8-cores", "linux"],
        env: { NODE_OPTIONS: "--max-old-space-size=16384" },
        matrixJobTotal: 4,
        matrixJobIndex: 2,
        hasServices: true,
        hasContainer: false,
      }),
    ).toEqual({
      labels: ["ubuntu-latest-8-cores", "linux"],
      requestedCpuCount: 8,
      requestedNodeHeapMb: 16384,
      matrixJobTotal: 4,
      matrixJobIndex: 2,
      hasServices: true,
      hasContainer: false,
    });
  });

  it("applies safe defaults for missing matrix and service hints", () => {
    expect(
      collectJobResourceHints({
        labels: ["ubuntu-latest"],
        env: {},
      }),
    ).toEqual({
      labels: ["ubuntu-latest"],
      requestedCpuCount: undefined,
      requestedNodeHeapMb: undefined,
      matrixJobTotal: 1,
      matrixJobIndex: 0,
      hasServices: false,
      hasContainer: false,
    });
  });
});

describe("classifyJobResources", () => {
  const sufficientHost: HostResources = {
    cpuCount: 12,
    totalMemoryMb: 32768,
    dockerHost: "unix:///var/run/docker.sock",
  };

  const tightHost: HostResources = {
    cpuCount: 4,
    totalMemoryMb: 16384,
    dockerHost: "unix:///var/run/docker.sock",
  };

  const requestedHints = collectJobResourceHints({
    labels: ["ubuntu-latest-8-cores"],
    env: { NODE_OPTIONS: "--max-old-space-size=16192" },
  });

  it("returns faithful classification on a sufficient host", () => {
    expect(classifyJobResources(requestedHints, sufficientHost)).toEqual({
      fidelity: "faithful",
      summary: "host resources satisfy declared job hints",
      reasons: [],
      action: "No action needed.",
    });
  });

  it("returns degraded classification on CPU mismatch", () => {
    expect(
      classifyJobResources(
        collectJobResourceHints({
          labels: ["ubuntu-latest-8-cores"],
          env: {},
        }),
        tightHost,
      ),
    ).toEqual({
      fidelity: "degraded",
      summary: "job resource hints exceed the available host capacity",
      reasons: ["requestedCpuCount (8) exceeds host cpuCount (4)"],
      action:
        "Use a larger host or set DOCKER_HOST=ssh://<user>@<host> for a remote Docker daemon.",
    });
  });

  it("returns degraded classification on memory mismatch", () => {
    expect(
      classifyJobResources(
        collectJobResourceHints({
          labels: ["ubuntu-latest"],
          env: { NODE_OPTIONS: "--max-old-space-size=16192" },
        }),
        {
          cpuCount: 12,
          totalMemoryMb: 16000,
          dockerHost: "unix:///var/run/docker.sock",
        },
      ),
    ).toEqual({
      fidelity: "degraded",
      summary: "job resource hints exceed the available host capacity",
      reasons: [
        "requestedNodeHeapMb (16192) plus 1024 MB safety margin exceeds host totalMemoryMb (16000)",
      ],
      action:
        "Use a larger host or set DOCKER_HOST=ssh://<user>@<host> for a remote Docker daemon.",
    });
  });

  it("returns degraded when host inspection fails with explicit hints", () => {
    expect(
      classifyJobResources(requestedHints, {
        cpuCount: Number.NaN,
        totalMemoryMb: Number.NaN,
        dockerHost: "unix:///var/run/docker.sock",
      }),
    ).toEqual({
      fidelity: "degraded",
      summary: "job resource hints exceed the available host capacity",
      reasons: ["host resource inspection failed while explicit resource hints were present"],
      action:
        "Use a larger host or set DOCKER_HOST=ssh://<user>@<host> for a remote Docker daemon.",
    });
  });
});
