import { execSync } from "node:child_process";
import fs from "node:fs";

export type HostCapability =
  | { supported: true }
  | { supported: false; reason: string; hint?: string };

export interface HostCapabilityEnv {
  platform?: NodeJS.Platform;
  arch?: string;
  whichSmolvm?: () => boolean;
  hasKvm?: () => boolean;
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultHasKvm(): boolean {
  try {
    return fs.existsSync("/dev/kvm");
  } catch {
    return false;
  }
}

// Can the host run smolvm? smolvm uses Hypervisor.framework on macOS (Apple
// Silicon supported; Intel listed as untested) and KVM on Linux. We're strict
// on macOS arch — Intel macOS is documented as untested upstream — and require
// /dev/kvm on Linux because libkrun fails opaquely without it.
export function checkSmolvmHost(env: HostCapabilityEnv = {}): HostCapability {
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  const whichSmolvm = env.whichSmolvm ?? (() => which("smolvm"));
  const hasKvm = env.hasKvm ?? defaultHasKvm;

  if (platform !== "darwin" && platform !== "linux") {
    return {
      supported: false,
      reason: `smolvm runner requires macOS or Linux (got ${platform}).`,
    };
  }
  if (platform === "darwin" && arch !== "arm64") {
    return {
      supported: false,
      reason: `smolvm runner on macOS requires Apple Silicon (got ${arch}).`,
      hint: "Intel macOS is listed as untested upstream — run on arm64 or use a Linux host.",
    };
  }
  if (platform === "linux" && !hasKvm()) {
    return {
      supported: false,
      reason: "smolvm runner on Linux requires /dev/kvm.",
      hint: "Enable KVM (kernel module + group membership) before retrying.",
    };
  }
  if (!whichSmolvm()) {
    return {
      supported: false,
      reason: "smolvm runner requires the `smolvm` binary on PATH.",
      hint: "Install: curl -sSL https://smolmachines.com/install.sh | bash",
    };
  }
  return { supported: true };
}
