import { createRequire } from "node:module";

import type { HostCapability } from "../runtime.ts";

export interface MachinenHostEnv {
  platform?: NodeJS.Platform;
  arch?: string;
  resolveRuntime?: () => boolean;
}

function defaultResolveRuntime(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("@machinen/runtime");
    return true;
  } catch {
    return false;
  }
}

// Can the host run the machinen runtime? machinen requires an arm64
// linux/darwin host with the `@machinen/runtime` optional dependency
// resolved. The optionalDependencies of `@machinen/runtime` restrict its
// VMM bindings to arm64-darwin / arm64-linux, so on any other host the
// require-resolve probe alone is sufficient — but we still check
// platform/arch first so the warning message is specific.
//
// Implementation gate: `executeMachinenJob` is currently a scaffold that
// throws `MachinenNotImplementedError`. To avoid making machinen the
// silently-selected runtime for every linux job on a supported host (and
// thereby breaking docker fallback), we require an explicit opt-in via
// `AGENT_CI_MACHINEN=1` until the execute path lands. Once the runtime
// is wired end-to-end (tasks #13 / #14), drop this gate.
export function checkMachinenHost(env: MachinenHostEnv = {}): HostCapability {
  const platform = env.platform ?? process.platform;
  const arch = env.arch ?? process.arch;
  const resolveRuntime = env.resolveRuntime ?? defaultResolveRuntime;

  if (platform !== "darwin" && platform !== "linux") {
    return {
      supported: false,
      reason: `machinen requires a macOS or Linux host (got ${platform}).`,
    };
  }
  if (arch !== "arm64") {
    return {
      supported: false,
      reason: `machinen requires an arm64 host (got ${arch}).`,
      hint: "Docker remains the default Linux runtime on x64 hosts.",
    };
  }
  if (!resolveRuntime()) {
    return {
      supported: false,
      reason: "machinen optional dependency `@machinen/runtime` did not resolve.",
      hint: "This usually means the package manager skipped it. Re-install dependencies; on supported hosts (arm64 darwin/linux) it installs automatically.",
    };
  }
  if (process.env.AGENT_CI_MACHINEN !== "1") {
    return {
      supported: false,
      reason: "machinen runtime is not yet enabled (execute path is in development).",
      hint: "Set AGENT_CI_MACHINEN=1 to opt in once the runtime is fully wired.",
    };
  }
  return { supported: true };
}
