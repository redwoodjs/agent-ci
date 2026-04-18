import { describe, it, expect } from "vitest";
import { checkMacosVmHost } from "./host-capability.js";

const ok = {
  platform: "darwin",
  arch: "arm64",
  whichTart: () => true,
  whichSshpass: () => true,
} as const;

describe("checkMacosVmHost", () => {
  it("returns supported on darwin + arm64 + tart + sshpass installed", () => {
    expect(checkMacosVmHost(ok)).toEqual({ supported: true });
  });

  it("rejects non-darwin hosts", () => {
    const r = checkMacosVmHost({ ...ok, platform: "linux", arch: "x64" });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/macOS host/);
  });

  it("rejects Intel macs", () => {
    const r = checkMacosVmHost({ ...ok, arch: "x64" });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/Apple Silicon/);
    expect(r.supported === false && r.hint).toMatch(/Virtualization\.framework/);
  });

  it("rejects hosts without tart installed", () => {
    const r = checkMacosVmHost({ ...ok, whichTart: () => false });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/tart/);
    expect(r.supported === false && r.hint).toMatch(/brew install/);
  });

  it("rejects hosts without sshpass installed", () => {
    const r = checkMacosVmHost({ ...ok, whichSshpass: () => false });
    expect(r.supported).toBe(false);
    expect(r.supported === false && r.reason).toMatch(/sshpass/);
    expect(r.supported === false && r.hint).toMatch(/brew install/);
  });
});
