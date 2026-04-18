import { describe, it, expect } from "vitest";
import { classifyRunsOn, isUnsupportedOS, formatUnsupportedOSWarning } from "./runs-on-compat.js";

describe("classifyRunsOn", () => {
  it("treats ubuntu-* as linux", () => {
    expect(classifyRunsOn(["ubuntu-latest"])).toBe("linux");
    expect(classifyRunsOn(["ubuntu-22.04"])).toBe("linux");
    expect(classifyRunsOn(["ubuntu"])).toBe("linux");
    expect(classifyRunsOn(["linux"])).toBe("linux");
  });

  it("treats macos-* as macos", () => {
    expect(classifyRunsOn(["macos-latest"])).toBe("macos");
    expect(classifyRunsOn(["macos-14"])).toBe("macos");
    expect(classifyRunsOn(["macos-13-large"])).toBe("macos");
    expect(classifyRunsOn(["macos"])).toBe("macos");
  });

  it("treats windows-* as windows", () => {
    expect(classifyRunsOn(["windows-latest"])).toBe("windows");
    expect(classifyRunsOn(["windows-2022"])).toBe("windows");
    expect(classifyRunsOn(["windows"])).toBe("windows");
  });

  it("preserves macOS classification when self-hosted labels are present", () => {
    // GitHub lets you write `runs-on: [self-hosted, macos, arm64]`. The OS
    // hint wins over self-hosted — otherwise the job silently lands in the
    // Linux container (#254).
    expect(classifyRunsOn(["self-hosted", "macos", "arm64"])).toBe("macos");
    expect(classifyRunsOn(["self-hosted", "macos-14"])).toBe("macos");
    expect(classifyRunsOn(["self-hosted", "windows", "x64"])).toBe("windows");
  });

  it("returns 'other' for empty, pure self-hosted, or unknown labels", () => {
    expect(classifyRunsOn([])).toBe("other");
    expect(classifyRunsOn(["self-hosted"])).toBe("other");
    expect(classifyRunsOn(["self-hosted", "arm64"])).toBe("other");
    expect(classifyRunsOn(["my-custom-label"])).toBe("other");
  });

  it("is case-insensitive", () => {
    expect(classifyRunsOn(["MacOS-Latest"])).toBe("macos");
    expect(classifyRunsOn(["Ubuntu-Latest"])).toBe("linux");
    expect(classifyRunsOn(["WINDOWS-2022"])).toBe("windows");
  });

  it("trims whitespace", () => {
    expect(classifyRunsOn(["  macos-latest  "])).toBe("macos");
  });
});

describe("isUnsupportedOS", () => {
  it("flags macos and windows as unsupported", () => {
    expect(isUnsupportedOS("macos")).toBe(true);
    expect(isUnsupportedOS("windows")).toBe(true);
  });

  it("allows linux and other", () => {
    expect(isUnsupportedOS("linux")).toBe(false);
    expect(isUnsupportedOS("other")).toBe(false);
  });
});

describe("formatUnsupportedOSWarning", () => {
  it("produces a macOS-specific message with the #258 tracker", () => {
    const msg = formatUnsupportedOSWarning("build-test", ["macos-latest"], "macos");
    expect(msg).toContain('Skipping job "build-test"');
    expect(msg).toContain("macOS");
    expect(msg).toContain("macos-latest");
    expect(msg).toContain("issues/258");
  });

  it("includes the host capability reason and hint when provided", () => {
    const msg = formatUnsupportedOSWarning("build-test", ["macos-15"], "macos", {
      reason: "macOS VM runner requires `tart` to be installed.",
      hint: "Install with: brew install cirruslabs/cli/tart",
    });
    expect(msg).toContain("tart` to be installed");
    expect(msg).toContain("brew install cirruslabs/cli/tart");
    // The generic "only runs in Linux container" line must not appear for
    // macOS, since macOS jobs *can* run locally when the host supports it.
    expect(msg).not.toContain("Linux container");
  });

  it("falls back to a generic macOS reason when no capability is provided", () => {
    const msg = formatUnsupportedOSWarning("build-test", ["macos-15"], "macos");
    expect(msg).toContain("cannot run macOS VMs");
    expect(msg).not.toContain("Linux container");
  });

  it("produces a Windows-specific message with the #254 tracker", () => {
    const msg = formatUnsupportedOSWarning("build", ["windows-2022"], "windows");
    expect(msg).toContain("Windows");
    expect(msg).toContain("windows-2022");
    expect(msg).toContain("issues/254");
    expect(msg).toContain("Linux container");
  });

  it("lists all labels when multiple were provided", () => {
    const msg = formatUnsupportedOSWarning("x", ["self-hosted", "macos", "arm64"], "macos");
    expect(msg).toContain("self-hosted, macos, arm64");
  });
});
