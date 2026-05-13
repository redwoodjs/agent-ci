import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkMachinenHost } from "./host-capability.ts";

describe("checkMachinenHost", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.AGENT_CI_MACHINEN;
    process.env.AGENT_CI_MACHINEN = "1";
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENT_CI_MACHINEN;
    } else {
      process.env.AGENT_CI_MACHINEN = original;
    }
  });

  it("returns supported on arm64 darwin when @machinen/runtime resolves and AGENT_CI_MACHINEN=1", () => {
    const cap = checkMachinenHost({
      platform: "darwin",
      arch: "arm64",
      resolveRuntime: () => true,
    });
    expect(cap.supported).toBe(true);
  });

  it("returns supported on arm64 linux when @machinen/runtime resolves and AGENT_CI_MACHINEN=1", () => {
    const cap = checkMachinenHost({
      platform: "linux",
      arch: "arm64",
      resolveRuntime: () => true,
    });
    expect(cap.supported).toBe(true);
  });

  it("is gated off by default (AGENT_CI_MACHINEN unset)", () => {
    delete process.env.AGENT_CI_MACHINEN;
    const cap = checkMachinenHost({
      platform: "darwin",
      arch: "arm64",
      resolveRuntime: () => true,
    });
    expect(cap.supported).toBe(false);
    if (!cap.supported) {
      expect(cap.reason).toMatch(/not yet enabled/);
      expect(cap.hint).toMatch(/AGENT_CI_MACHINEN=1/);
    }
  });

  it("rejects x64 hosts with an arch-specific reason", () => {
    const cap = checkMachinenHost({
      platform: "linux",
      arch: "x64",
      resolveRuntime: () => true,
    });
    expect(cap.supported).toBe(false);
    if (!cap.supported) {
      expect(cap.reason).toMatch(/arm64/);
      expect(cap.reason).toMatch(/x64/);
    }
  });

  it("rejects windows hosts with a platform-specific reason", () => {
    const cap = checkMachinenHost({
      platform: "win32",
      arch: "arm64",
      resolveRuntime: () => true,
    });
    expect(cap.supported).toBe(false);
    if (!cap.supported) {
      expect(cap.reason).toMatch(/macOS or Linux/);
    }
  });

  it("rejects arm64 hosts where @machinen/runtime is missing", () => {
    const cap = checkMachinenHost({
      platform: "darwin",
      arch: "arm64",
      resolveRuntime: () => false,
    });
    expect(cap.supported).toBe(false);
    if (!cap.supported) {
      expect(cap.reason).toMatch(/@machinen\/runtime/);
    }
  });
});
