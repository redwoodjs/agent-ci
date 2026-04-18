import { execSync } from "node:child_process";

export type HostCapability =
  | { supported: true }
  | { supported: false; reason: string; hint?: string };

export interface HostCapabilityEnv {
  platform?: NodeJS.Platform;
  arch?: string;
  whichTart?: () => boolean;
  whichSshpass?: () => boolean;
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Can the host actually run macOS VMs? macOS VMs require Apple's
// Virtualization.framework, which needs an Apple Silicon macOS host with tart
// installed. Anywhere else we fall back to the Phase 2 skip behavior.
export function checkMacosVmHost(env: HostCapabilityEnv = {}): HostCapability {
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  const whichTart = env.whichTart ?? (() => which("tart"));
  const whichSshpass = env.whichSshpass ?? (() => which("sshpass"));

  if (platform !== "darwin") {
    return {
      supported: false,
      reason: `macOS VM runner requires a macOS host (got ${platform}).`,
    };
  }
  if (arch !== "arm64") {
    return {
      supported: false,
      reason: `macOS VM runner requires an Apple Silicon host (got ${arch}).`,
      hint: "Apple's Virtualization.framework does not support macOS guests on Intel Macs.",
    };
  }
  if (!whichTart()) {
    return {
      supported: false,
      reason: "macOS VM runner requires `tart` to be installed.",
      hint: "Install with: brew install cirruslabs/cli/tart",
    };
  }
  if (!whichSshpass()) {
    return {
      supported: false,
      reason: "macOS VM runner requires `sshpass` to be installed.",
      hint: "Install with: brew install hudochenkov/sshpass/sshpass",
    };
  }
  return { supported: true };
}
