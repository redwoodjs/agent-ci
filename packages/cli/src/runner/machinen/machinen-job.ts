// executeMachinenJob — full GHA-runner-in-microVM execution.
//
// Mirrors `executeLocalJob` (docker) using machinen primitives. ADR
// 0003 captures the substrate-specific decisions; the broad strokes:
//
//   - Boot a long-lived `sleep infinity` VM from the resolved rootfs.
//   - Live-mount the per-run host dirs (work, shims, signals, diag,
//     caches) under `/mnt/...` and symlink the runner's conventional
//     paths to them inside the guest.
//   - Inject `.runner` / `.credentials` / `.credentials_rsaparams`
//     via `vm.writeFile` so we skip the .NET config.sh cold-start.
//   - `vm.exec /home/runner/run.sh --once` for the workload; stream
//     stdout/stderr into the host-side debug log.
//   - Concurrently poll `timeline.json` via the shared timeline-sync
//     helper to drive the renderer and detect step failures.
//   - Pause/retry rides the same signals-dir protocol the docker path
//     uses — liveMount makes it work unchanged.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { startEphemeralDtu } from "dtu-github-actions/ephemeral";

import { config } from "../../config.ts";
import { writeDetachedMarker } from "../../launcher.ts";
import { debugBoot, debugRunner } from "../../output/debug.ts";
import { createLogContext } from "../../output/logger.ts";
import { type JobResult } from "../../output/reporter.ts";
import { RunStateStore } from "../../output/run-state.ts";
import { getWorkingDirectory } from "../../output/working-directory.ts";
import type { Job } from "../../types.ts";

import { createRunDirectories } from "../directory-setup.ts";
import { writeGitShim } from "../git-shim.ts";
import { findRepoRoot, writeJobMetadata } from "../metadata.ts";
import { buildJobResult, isJobSuccessful } from "../result-builder.ts";
import { buildRunnerCredentials } from "../runner-credentials.ts";
import { appendOutputCaptureStep, wrapJobSteps } from "../step-wrapper.ts";
import { syncWorkspaceForRetry } from "../sync.ts";
import {
  syncTimelineToStore,
  type TimelineSyncContext,
  type TimelineSyncState,
} from "../timeline-sync.ts";
import { prepareWorkspace } from "../workspace.ts";

import { resolveMachinenImage } from "./image-mapping.ts";

// ─── Tunables ────────────────────────────────────────────────────────────────

// gvproxy's user-mode NAT exposes the host's loopback at 192.168.127.254.
// (The `.1` address is gvproxy's gateway services like DNS — not the host;
// the guest itself sits at `.2`.) The DTU binds to 0.0.0.0:<random> on the
// host so the guest can hit `http://192.168.127.254:<port>/`.
const GUEST_HOST_IP = "192.168.127.254";

// 60s ceiling on individual `vm.exec` calls during setup. The long-running
// run.sh exec uses `execTimeoutMs: null` so it lives for the whole job.
const SETUP_EXEC_TIMEOUT_MS = 60_000;

// ─── @machinen/runtime shape (subset we touch) ───────────────────────────────

interface MachinenVm {
  readonly pid: number;
  exec(
    cmd: string,
    opts?: {
      execTimeoutMs?: number | null;
      onStdout?: (chunk: Buffer) => void;
      onStderr?: (chunk: Buffer) => void;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFile(
    guestPath: string,
    contents: Buffer | string,
    opts?: { mode?: number; recursive?: boolean },
  ): Promise<void>;
  kill(): Promise<void>;
}

interface MachinenLiveMount {
  host: string;
  guest: string;
  mode?: "ro" | "rw";
}

interface MachinenRuntimeModule {
  boot?: (opts: {
    image: string;
    cmd?: string[];
    env?: Record<string, string>;
    name?: string;
    kernel?: string;
    dtb?: string;
    liveMounts?: MachinenLiveMount[];
    timeoutMs?: number | null;
  }) => Promise<MachinenVm>;
  resolveBaseKernel?: (explicit?: string, cwd?: string) => string;
  resolveBaseDtb?: (explicit?: string, cwd?: string) => string;
}

async function loadMachinenRuntime(): Promise<MachinenRuntimeModule> {
  try {
    return (await import("@machinen/runtime")) as MachinenRuntimeModule;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      "machinen runtime selected but `@machinen/runtime` did not resolve.\n" +
        `  Underlying error: ${reason}\n` +
        "  Set AGENT_CI_RUNTIME=docker to fall back to docker.",
    );
  }
}

// ─── Guest path conventions ──────────────────────────────────────────────────

// LiveMount targets — each host dir lands at /mnt/<name> in the guest,
// then we symlink the runner's conventional paths onto them.
const GUEST_WORK_MNT = "/mnt/work";
const GUEST_SHIMS_MNT = "/mnt/shims";
const GUEST_SIGNALS_MNT = "/mnt/signals";
const GUEST_DIAG_MNT = "/mnt/diag";

// Where the runner expects to find its world. The bake puts run.sh +
// the runner binary at /home/runner; everything else lands via symlink
// onto the mount targets above.
const GUEST_RUNNER_DIR = "/home/runner";
const GUEST_RUNNER_WORK = "/home/runner/_work";
const GUEST_RUNNER_DIAG = "/home/runner/_diag";
const GUEST_SHIMS_DIR = "/tmp/agent-ci-shims";
const GUEST_SIGNALS_DIR = "/tmp/agent-ci-signals";

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function executeMachinenJob(
  job: Job,
  options?: { pauseOnFailure?: boolean; store?: RunStateStore },
): Promise<JobResult> {
  const mod = await loadMachinenRuntime();
  if (typeof mod.boot !== "function") {
    throw new Error("`@machinen/runtime` does not export `boot()`.");
  }
  if (typeof mod.resolveBaseKernel !== "function" || typeof mod.resolveBaseDtb !== "function") {
    throw new Error("`@machinen/runtime` is missing resolveBaseKernel / resolveBaseDtb exports.");
  }

  const pauseOnFailure = options?.pauseOnFailure ?? false;
  const store = options?.store;
  const startTime = Date.now();

  const {
    name: vmName,
    runDir,
    logDir,
    debugLogPath,
  } = createLogContext("agent-ci-machinen", job.runnerName);
  job.runnerName = vmName;

  store?.addJob(job.parentWorkflowPath ?? job.workflowPath ?? "", job.taskId ?? "job", vmName, {
    logDir,
    debugLogPath,
  });
  store?.updateJob(vmName, {
    status: "booting",
    startedAt: new Date().toISOString(),
    logDir,
    debugLogPath,
  });

  const bootStart = Date.now();
  const bt = (label: string, since: number) => {
    debugBoot(`${vmName} ${label}: ${Date.now() - since}ms`);
    return Date.now();
  };
  let t0 = bootStart;

  // ── Resolve rootfs ────────────────────────────────────────────────────────
  const repoRoot = (job.workflowPath && findRepoRoot(job.workflowPath)) || process.cwd();
  const image = await resolveMachinenImage({ repoRoot });
  debugRunner(`[machinen] ${vmName}: rootfs source=${image.source} path=${image.rootfsPath}`);
  t0 = bt("rootfs-resolve", t0);

  // ── Start ephemeral DTU ───────────────────────────────────────────────────
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  let ephemeralDtu: Awaited<ReturnType<typeof startEphemeralDtu>> | null = null;
  try {
    ephemeralDtu = await startEphemeralDtu(dtuCacheDir);
    debugRunner(`[machinen] ${vmName}: DTU started cli-url=${ephemeralDtu.url}`);
  } catch (err) {
    debugRunner(`[machinen] ${vmName}: ephemeral DTU failed to start: ${err}`);
  }
  t0 = bt("dtu-start", t0);

  // The CLI uses url (127.0.0.1); the guest uses guestUrl (gvproxy gateway).
  const dtuCliUrl = ephemeralDtu?.url ?? config.GITHUB_API_URL;
  const dtuParsed = new URL(dtuCliUrl);
  const dtuPort = dtuParsed.port || (dtuParsed.protocol === "https:" ? "443" : "80");
  const dtuGuestUrl = `${dtuParsed.protocol}//${GUEST_HOST_IP}:${dtuPort}`;

  // ── Per-run dirs ──────────────────────────────────────────────────────────
  const dirs = createRunDirectories({
    runDir,
    githubRepo: job.githubRepo!,
    workflowPath: job.workflowPath,
  });
  debugRunner(
    `[machinen] ${vmName}: package manager = ${dirs.detectedPM ?? "none (mounting all PM caches)"}`,
  );

  writeDetachedMarker(runDir);

  await fetch(`${dtuCliUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerName: vmName,
      logDir,
      timelineDir: logDir,
      virtualCachePatterns: dirs.detectedPM
        ? dirs.detectedPM === "bun"
          ? []
          : [dirs.detectedPM]
        : ["pnpm", "npm", "yarn"],
    }),
  }).catch(() => {
    /* non-fatal */
  });
  t0 = bt("dtu-register", t0);

  writeJobMetadata({ logDir, containerName: vmName, job });
  const debugStream = fs.createWriteStream(debugLogPath);

  // ── Workspace + shims ─────────────────────────────────────────────────────
  writeGitShim(dirs.shimsDir, job.realHeadSha);
  await prepareWorkspace({
    workflowPath: job.workflowPath,
    headSha: job.headSha,
    githubRepo: job.githubRepo,
    workspaceDir: dirs.workspaceDir,
  }).catch((err) => debugRunner(`[machinen] ${vmName}: prepareWorkspace failed: ${err}`));
  t0 = bt("workspace-prep", t0);

  // ── Cleanup tracking ──────────────────────────────────────────────────────
  let vm: MachinenVm | null = null;
  const signalCleanup = () => {
    if (vm) {
      vm.kill().catch(() => {});
    }
    for (const d of [dirs.containerWorkDir, dirs.shimsDir, dirs.signalsDir, dirs.diagDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  };
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);
  process.on("SIGHUP", signalCleanup);

  try {
    // ── Seed the job into the DTU ──────────────────────────────────────────
    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;

    const wrappedSteps = pauseOnFailure ? wrapJobSteps(job.steps ?? [], true) : job.steps;
    const seededSteps = appendOutputCaptureStep(wrappedSteps ?? []);

    const seedResponse = await fetch(`${dtuCliUrl}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        localPath: dirs.workspaceDir,
        ...job,
        steps: seededSteps,
        repository: overriddenRepository,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }
    t0 = bt("dtu-seed", t0);

    // ── Boot the VM ────────────────────────────────────────────────────────
    // First-cut mount set: just work, diag, shims, and the signals
    // dir when pause-on-failure is on. The other caches (toolcache,
    // pnpm/npm/bun, playwright, warm-modules) hit a machinen
    // "agent closed connection before X frame" failure when included
    // — likely a per-VM FUSE-server resource ceiling. Re-add them
    // incrementally once we have a smoke baseline.
    const liveMounts: MachinenLiveMount[] = [
      { host: dirs.containerWorkDir, guest: GUEST_WORK_MNT, mode: "rw" },
      { host: dirs.shimsDir, guest: GUEST_SHIMS_MNT, mode: "rw" },
      { host: dirs.diagDir, guest: GUEST_DIAG_MNT, mode: "rw" },
    ];
    if (pauseOnFailure) {
      liveMounts.push({ host: dirs.signalsDir, guest: GUEST_SIGNALS_MNT, mode: "rw" });
    }

    // Ensure each host dir exists before machinen's FUSE bridge wants to
    // open it — liveMounts errors loudly otherwise.
    await Promise.all(
      liveMounts.map((lm) => fsp.mkdir(lm.host, { recursive: true }).catch(() => {})),
    );

    debugRunner(`[machinen] ${vmName}: booting VM with ${liveMounts.length} live mounts`);
    vm = await mod.boot({
      image: image.rootfsPath,
      kernel: mod.resolveBaseKernel(),
      dtb: mod.resolveBaseDtb(),
      name: vmName,
      cmd: ["/bin/sh", "-c", "exec sleep infinity"],
      liveMounts,
      // No wall-clock cap on the supervisor sleep — we kill the VM ourselves.
      timeoutMs: null,
    });
    debugRunner(`[machinen] ${vmName}: VM up pid=${vm.pid}`);
    t0 = bt("vm-boot", t0);

    // ── Stage the runner's view inside the guest ──────────────────────────
    await runExec(
      vm,
      stagingScript(pauseOnFailure, dirs),
      "stage",
      debugStream,
      SETUP_EXEC_TIMEOUT_MS,
    );
    t0 = bt("vm-stage", t0);

    // ── Push credentials inside the guest ─────────────────────────────────
    const creds = buildRunnerCredentials(vmName, `${dtuGuestUrl}/${job.githubRepo}`);
    await vm.writeFile(`${GUEST_RUNNER_DIR}/.runner`, creds.dotRunner);
    await vm.writeFile(`${GUEST_RUNNER_DIR}/.credentials`, creds.dotCredentials);
    await vm.writeFile(`${GUEST_RUNNER_DIR}/.credentials_rsaparams`, creds.dotRsaParams);
    t0 = bt("vm-credentials", t0);

    // ── Launch the runner ─────────────────────────────────────────────────
    const timelinePath = path.join(logDir, "timeline.json");
    const pausedSignalPath = path.join(dirs.signalsDir, "paused");

    const timelineState: TimelineSyncState = {
      lastSeenAttempt: 0,
      isPaused: false,
      pausedAtMs: null,
      pausedStepName: null,
      isBooting: true,
      lastFailedStep: null,
    };

    let stdinListening = false;
    const setupStdinRetry = () => {
      if (stdinListening || !process.stdin.isTTY) {
        return;
      }
      stdinListening = true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (key: Buffer) => {
        if (key[0] === 3) {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        if (key[0] === 13 && timelineState.isPaused) {
          syncWorkspaceForRetry(path.dirname(dirs.signalsDir));
          fs.writeFileSync(path.join(dirs.signalsDir, "retry"), "");
        }
      });
    };
    const cleanupStdin = () => {
      if (stdinListening && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
        stdinListening = false;
      }
    };

    const timelineCtx: TimelineSyncContext = {
      pauseOnFailure,
      pausedSignalPath,
      signalsDir: dirs.signalsDir,
      timelinePath,
      bootStart,
      containerName: vmName,
      store,
      onNewPause: setupStdinRetry,
    };

    let runnerDone = false;
    const pollPromise = (async () => {
      while (!runnerDone) {
        syncTimelineToStore(timelineState, timelineCtx);
        await new Promise((r) => setTimeout(r, 100));
      }
      syncTimelineToStore(timelineState, timelineCtx);
    })();

    debugRunner(`[machinen] ${vmName}: launching run.sh`);
    // RUNNER_ALLOW_RUNASROOT=1 — the GHA runner refuses to run as
    // root by default. The docker path runs as the image's `runner`
    // user; our debian rootfs has no such user, and exec-agent runs
    // commands as root. The env override is the upstream-supported
    // way to bypass the check.
    const runResult = await vm.exec(
      `cd ${GUEST_RUNNER_DIR} && RUNNER_ALLOW_RUNASROOT=1 exec ./run.sh --once`,
      {
        execTimeoutMs: null,
        onStdout: (chunk) => debugStream.write(chunk),
        onStderr: (chunk) => debugStream.write(chunk),
      },
    );
    runnerDone = true;
    cleanupStdin();
    await pollPromise;
    await new Promise<void>((resolve) => debugStream.end(resolve));

    const jobSucceeded = isJobSuccessful({
      lastFailedStep: timelineState.lastFailedStep,
      containerExitCode: runResult.exitCode,
      isBooting: timelineState.isBooting,
    });

    if (!jobSucceeded) {
      store?.updateJob(vmName, {
        failedExitCode: runResult.exitCode !== 0 ? runResult.exitCode : undefined,
      });
    }

    let stepOutputs: Record<string, string> = {};
    if (jobSucceeded) {
      const outputsFile = path.join(logDir, "outputs.json");
      try {
        if (fs.existsSync(outputsFile)) {
          stepOutputs = JSON.parse(fs.readFileSync(outputsFile, "utf8"));
        }
      } catch {
        /* best-effort */
      }
    }

    if (jobSucceeded && fs.existsSync(dirs.containerWorkDir)) {
      try {
        fs.rmSync(dirs.containerWorkDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the VM may still hold open fds briefly.
      }
    }

    return buildJobResult({
      containerName: vmName,
      job,
      startTime,
      jobSucceeded,
      lastFailedStep: timelineState.lastFailedStep,
      containerExitCode: runResult.exitCode,
      timelinePath,
      logDir,
      debugLogPath,
      stepOutputs,
      resolvedRunnerImage: {
        image: image.rootfsPath,
        source: "default",
        sourceLabel: `machinen rootfs (${image.source})`,
        needsBuild: false,
      },
      toolCacheDir: dirs.toolCacheDir,
    });
  } finally {
    try {
      await vm?.kill();
    } catch {
      /* already gone */
    }
    const rmOpts = { recursive: true, force: true } as const;
    await Promise.all([
      fsp.rm(dirs.shimsDir, rmOpts).catch(() => {}),
      pauseOnFailure ? undefined : fsp.rm(dirs.signalsDir, rmOpts).catch(() => {}),
      fsp.rm(dirs.diagDir, rmOpts).catch(() => {}),
    ]);
    await ephemeralDtu?.close().catch(() => {});
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
    process.removeListener("SIGHUP", signalCleanup);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build the shell script that prepares the rootfs for run.sh:
 *
 *   - Symlinks /home/runner/_work etc. → the live-mount targets.
 *   - Installs the host's git shim over /usr/bin/git.
 *   - Creates the workspace dir the runner will chdir into.
 *
 * Everything runs in the guest via a single `vm.exec` so we get one
 * exit code back for the whole staging phase.
 */
function stagingScript(
  pauseOnFailure: boolean,
  dirs: ReturnType<typeof createRunDirectories>,
): string {
  const repoName = (dirs.repoSlug.split("-").pop() || dirs.repoSlug).trim() || "repo";
  const lines: string[] = ["set -e"];
  lines.push(`mkdir -p ${GUEST_RUNNER_DIR}`);
  // Symlink the runner's conventional paths onto the live-mount targets.
  // `ln -sfn` overwrites existing symlinks; for existing dirs we first
  // rm so the symlink lands cleanly.
  const symlink = (src: string, dst: string) => {
    lines.push(`rm -rf ${dst}`);
    lines.push(`mkdir -p $(dirname ${dst})`);
    lines.push(`ln -sfn ${src} ${dst}`);
  };
  symlink(GUEST_WORK_MNT, GUEST_RUNNER_WORK);
  symlink(GUEST_SHIMS_MNT, GUEST_SHIMS_DIR);
  symlink(GUEST_DIAG_MNT, GUEST_RUNNER_DIAG);
  if (pauseOnFailure) {
    symlink(GUEST_SIGNALS_MNT, GUEST_SIGNALS_DIR);
  }
  // Workspace dir the runner chdir's into.
  lines.push(`mkdir -p ${GUEST_WORK_MNT}/${repoName}/${repoName}`);
  // Git shim: the host put the shim under /mnt/shims/git; move the real
  // git out of the way and drop the shim in its place.
  lines.push(
    "if [ -f /usr/bin/git ] && [ ! -f /usr/bin/git.real ]; then mv /usr/bin/git /usr/bin/git.real; fi",
  );
  lines.push(`if [ -f ${GUEST_SHIMS_DIR}/git ]; then cp ${GUEST_SHIMS_DIR}/git /usr/bin/git; fi`);
  lines.push("chmod +x /usr/bin/git || true");
  return lines.join("\n");
}

async function runExec(
  vm: MachinenVm,
  cmd: string,
  label: string,
  debugStream: fs.WriteStream,
  timeoutMs: number,
): Promise<void> {
  const result = await vm.exec(cmd, {
    execTimeoutMs: timeoutMs,
    onStdout: (chunk) => debugStream.write(chunk),
    onStderr: (chunk) => debugStream.write(chunk),
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `machinen vm.exec [${label}] failed (exit ${result.exitCode}). ` +
        `stderr (tail): ${result.stderr.slice(-1024)}`,
    );
  }
}
