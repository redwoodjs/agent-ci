import { describe, it, expect } from "vitest";

import { selectRuntime, __test_probeFromMap } from "./runtime.ts";

const ok = { supported: true } as const;
const fail = (reason: string) => ({ supported: false, reason });

describe("selectRuntime", () => {
  it("prefers machinen for linux when machinen is supported", () => {
    const probed = __test_probeFromMap({
      machinen: ok,
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed)?.name).toBe("machinen");
  });

  it("falls back to docker for linux when machinen is unsupported", () => {
    const probed = __test_probeFromMap({
      machinen: fail("optional dep did not resolve"),
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed)?.name).toBe("docker");
  });

  it("AGENT_CI_RUNTIME=docker forces docker on an arm64 host with machinen available", () => {
    const probed = __test_probeFromMap({
      machinen: ok,
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed, "docker")?.name).toBe("docker");
  });

  it("AGENT_CI_RUNTIME=machinen on a host without machinen falls back to priority order", () => {
    const probed = __test_probeFromMap({
      machinen: fail("optional dep did not resolve"),
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed, "machinen")?.name).toBe("docker");
  });

  it("AGENT_CI_RUNTIME=docker on a macOS job does not coerce to docker — returns null so the unsupported-OS skip fires", () => {
    const probed = __test_probeFromMap({
      machinen: fail("not arm64 linux"),
      "macos-vm": fail("tart not installed"),
      docker: ok,
    });
    expect(selectRuntime("macos", probed, "docker")).toBeNull();
  });

  it("selects macos-vm for macOS jobs when the host supports it", () => {
    const probed = __test_probeFromMap({
      machinen: fail("not arm64 linux"),
      "macos-vm": ok,
      docker: ok,
    });
    expect(selectRuntime("macos", probed)?.name).toBe("macos-vm");
  });

  it("returns null for windows — no runtime supports it", () => {
    const probed = __test_probeFromMap({
      machinen: ok,
      "macos-vm": ok,
      docker: ok,
    });
    expect(selectRuntime("windows", probed)).toBeNull();
  });

  it("treats `other` as linux-compatible and selects docker by default", () => {
    const probed = __test_probeFromMap({
      machinen: fail("not arm64 linux"),
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("other", probed)?.name).toBe("docker");
  });

  it("ignores an unknown AGENT_CI_RUNTIME value and uses priority order", () => {
    const probed = __test_probeFromMap({
      machinen: ok,
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed, "podman")?.name).toBe("machinen");
  });

  it("treats empty-string override as no override", () => {
    const probed = __test_probeFromMap({
      machinen: ok,
      "macos-vm": fail("not macOS"),
      docker: ok,
    });
    expect(selectRuntime("linux", probed, "")?.name).toBe("machinen");
  });
});
