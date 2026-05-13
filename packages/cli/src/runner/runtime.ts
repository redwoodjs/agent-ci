// Runtime selection.
//
// agent-ci ships three runtimes — docker, macos-vm, machinen — and selects
// one per-job based on the job's `runs-on:` OS family, host capability, and
// the `AGENT_CI_RUNTIME` env var. Selection follows ADR 0001:
// docs/adr/0001-machinen-default-on-arm64.md.
//
// Priority order: `[machinen, macos-vm, docker]`. The first runtime whose
// `checkHost()` succeeds AND whose `supportsJob(kind)` returns true wins.
// `AGENT_CI_RUNTIME` reorders the candidate set (it moves the named runtime
// to the front) but does not bypass `supportsJob` — setting
// `AGENT_CI_RUNTIME=docker` on a `runs-on: macos-15` job still skips,
// because docker does not support macOS.

import type { Job } from "../types.ts";
import type { JobResult } from "../output/reporter.ts";
import type { RunStateStore } from "../output/run-state.ts";

import { executeLocalJob } from "./local-job.ts";
import { executeMacosVmJob } from "./macos-vm/macos-vm-job.ts";
import { checkMacosVmHost } from "./macos-vm/host-capability.ts";
import { executeMachinenJob } from "./machinen/machinen-job.ts";
import { checkMachinenHost } from "./machinen/host-capability.ts";
import type { RunnerOSKind } from "./runs-on-compat.ts";

export type HostCapability =
  | { supported: true }
  | { supported: false; reason: string; hint?: string };

export type RuntimeName = "machinen" | "macos-vm" | "docker";

export interface RuntimeExecuteOpts {
  pauseOnFailure?: boolean;
  store?: RunStateStore;
}

export interface Runtime {
  name: RuntimeName;
  checkHost(): HostCapability;
  supportsJob(kind: RunnerOSKind): boolean;
  execute(job: Job, opts: RuntimeExecuteOpts): Promise<JobResult>;
}

const PRIORITY: RuntimeName[] = ["machinen", "macos-vm", "docker"];

const machinen: Runtime = {
  name: "machinen",
  checkHost: checkMachinenHost,
  supportsJob: (kind) => kind === "linux" || kind === "other",
  execute: (job, opts) => executeMachinenJob(job, opts),
};

const macosVm: Runtime = {
  name: "macos-vm",
  checkHost: checkMacosVmHost,
  supportsJob: (kind) => kind === "macos",
  execute: (job) => executeMacosVmJob(job),
};

const docker: Runtime = {
  name: "docker",
  // Docker is the historical default; the local-job code raises a clear
  // "Docker is not running" error at execute() time if the daemon is
  // unreachable. We always advertise it as supported so the existing
  // diagnostic path is preserved.
  checkHost: () => ({ supported: true }),
  supportsJob: (kind) => kind === "linux" || kind === "other",
  execute: (job, opts) => executeLocalJob(job, opts),
};

const ALL: Record<RuntimeName, Runtime> = {
  machinen,
  "macos-vm": macosVm,
  docker,
};

export interface ProbedRuntime {
  runtime: Runtime;
  host: HostCapability;
}

/**
 * Probe every runtime's host capability once. Callers cache the result for
 * the lifetime of an `agent-ci run` invocation.
 */
export function probeRuntimes(): ProbedRuntime[] {
  return PRIORITY.map((name) => {
    const runtime = ALL[name];
    return { runtime, host: runtime.checkHost() };
  });
}

/**
 * Pick the runtime for a job.
 *
 * Returns `null` when no runtime in the registry can handle `kind` on this
 * host — caller is responsible for the unsupported-OS warning + skip.
 *
 * `override` (typically `process.env.AGENT_CI_RUNTIME`) moves the named
 * runtime to the front of the candidate set. It does not bypass
 * `supportsJob`: an override that names a runtime which doesn't support
 * `kind` is ignored, and priority order applies.
 */
export function selectRuntime(
  kind: RunnerOSKind,
  probed: ProbedRuntime[],
  override?: string | null | undefined,
): Runtime | null {
  const candidates = probed.filter((p) => p.runtime.supportsJob(kind) && p.host.supported);
  if (candidates.length === 0) {
    return null;
  }
  if (override) {
    const preferred = candidates.find((c) => c.runtime.name === override);
    if (preferred) {
      return preferred.runtime;
    }
  }
  return candidates[0].runtime;
}

/** Test-only: build a probed-runtime list from a partial map. */
export function __test_probeFromMap(
  map: Partial<Record<RuntimeName, HostCapability>>,
): ProbedRuntime[] {
  return PRIORITY.map((name) => ({
    runtime: ALL[name],
    host: map[name] ?? { supported: false, reason: "not probed in test" },
  }));
}
