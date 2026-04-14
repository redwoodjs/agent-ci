import { describe, expect, it } from "vitest";
import {
  collectJobResourceHints,
  classifyJobResources,
  type HostResources,
  parseRunnerSpecs,
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

describe("parseRunnerSpecs", () => {
  it("maps ubuntu-latest to the standard GitHub runner spec", () => {
    expect(parseRunnerSpecs(["ubuntu-latest"])).toEqual({ cpu: 2, memoryMb: 7168 });
  });

  it("maps larger hosted runners to their full specs", () => {
    expect(parseRunnerSpecs(["ubuntu-latest-16-cores"])).toEqual({ cpu: 16, memoryMb: 65536 });
  });

  it("prefers the last known runner label", () => {
    expect(parseRunnerSpecs(["ubuntu-latest", "ubuntu-latest-8-cores"])).toEqual({
      cpu: 8,
      memoryMb: 32768,
    });
  });

  it("returns undefined for custom runners", () => {
    expect(parseRunnerSpecs(["self-hosted", "linux", "x64", "custom-12-cores"])).toBeUndefined();
  });
});

describe("collectJobResourceHints", () => {
  it("packages workflow accessors into a hint object", () => {
    expect(
      collectJobResourceHints({
        labels: ["ubuntu-latest-8-cores", "linux"],
        matrixJobTotal: 4,
        matrixJobIndex: 2,
        hasServices: true,
        hasContainer: false,
      }),
    ).toEqual({
      labels: ["ubuntu-latest-8-cores", "linux"],
      requestedCpuCount: 8,
      requestedNodeHeapMb: 32768,
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
      }),
    ).toEqual({
      labels: ["ubuntu-latest"],
      requestedCpuCount: 2,
      requestedNodeHeapMb: 7168,
      matrixJobTotal: 1,
      matrixJobIndex: 0,
      hasServices: false,
      hasContainer: false,
    });
  });

  it("falls back to CPU parsing for unknown custom runners", () => {
    expect(
      collectJobResourceHints({
        labels: ["self-hosted", "linux", "x64", "custom-12-cores"],
      }),
    ).toEqual({
      labels: ["self-hosted", "linux", "x64", "custom-12-cores"],
      requestedCpuCount: 12,
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
    totalMemoryMb: 40960,
    dockerHost: "unix:///var/run/docker.sock",
  };

  const tightHost: HostResources = {
    cpuCount: 4,
    totalMemoryMb: 40960,
    dockerHost: "unix:///var/run/docker.sock",
  };

  const requestedHints = collectJobResourceHints({
    labels: ["ubuntu-latest-8-cores"],
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
        }),
        tightHost,
      ),
    ).toEqual({
      fidelity: "degraded",
      summary: "job resource hints exceed the available host capacity",
      reasons: ["requestedCpuCount (8) exceeds host cpuCount (4)"],
      action:
        "Use a larger host or adjust the workflow resource hints to fit the available machine.",
    });
  });

  it("returns degraded classification on memory mismatch", () => {
    expect(
      classifyJobResources(
        collectJobResourceHints({
          labels: ["ubuntu-latest"],
        }),
        {
          cpuCount: 12,
          totalMemoryMb: 8000,
          dockerHost: "unix:///var/run/docker.sock",
        },
      ),
    ).toEqual({
      fidelity: "degraded",
      summary: "job resource hints exceed the available host capacity",
      reasons: [
        "requestedNodeHeapMb (7168) plus 1024 MB safety margin exceeds host totalMemoryMb (8000)",
      ],
      action:
        "Use a larger host or adjust the workflow resource hints to fit the available machine.",
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
        "Use a larger host or adjust the workflow resource hints to fit the available machine.",
    });
  });
});
