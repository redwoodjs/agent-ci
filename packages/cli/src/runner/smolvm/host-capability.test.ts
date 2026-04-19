import { describe, it, expect } from "vitest";
import { checkSmolvmHost } from "./host-capability.js";

const macOk = {
  platform: "darwin" as NodeJS.Platform,
  arch: "arm64",
  whichSmolvm: () => true,
  hasKvm: () => false, // ignored on darwin
};
const linuxOk = {
  platform: "linux" as NodeJS.Platform,
  arch: "x64",
  whichSmolvm: () => true,
  hasKvm: () => true,
};

describe("checkSmolvmHost", () => {
  it("supports darwin + arm64 + smolvm installed", () => {
    expect(checkSmolvmHost(macOk)).toEqual({ supported: true });
  });

  it("supports linux + smolvm + /dev/kvm", () => {
    expect(checkSmolvmHost(linuxOk)).toEqual({ supported: true });
  });

  it("rejects windows hosts", () => {
    const r = checkSmolvmHost({ ...macOk, platform: "win32" });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/macOS or Linux/);
  });

  it("rejects Intel macs", () => {
    const r = checkSmolvmHost({ ...macOk, arch: "x64" });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/Apple Silicon/);
    expect(r.supported === false && r.hint).toMatch(/untested/);
  });

  it("rejects linux without /dev/kvm", () => {
    const r = checkSmolvmHost({ ...linuxOk, hasKvm: () => false });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/\/dev\/kvm/);
    expect(r.supported === false && r.hint).toMatch(/KVM/);
  });

  it("rejects hosts without smolvm installed", () => {
    const r = checkSmolvmHost({ ...macOk, whichSmolvm: () => false });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/smolvm/);
    expect(r.supported === false && r.hint).toMatch(/install\.sh/);
  });
});
