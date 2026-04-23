import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startEphemeralDtu } from "dtu-github-actions/ephemeral";

import { Job } from "../../types.js";
import { getWorkingDirectory } from "../../output/working-directory.js";
import { createLogContext } from "../../output/logger.js";
import { debugRunner, debugBoot } from "../../output/debug.js";
import { type JobResult } from "../../output/reporter.js";
import { buildJobResult, isJobSuccessful } from "../result-builder.js";
import { writeJobMetadata } from "../metadata.js";
import { appendOutputCaptureStep } from "../step-wrapper.js";
import { writeRunnerCredentials } from "../runner-credentials.js";
import { classifyRunsOn } from "../runs-on-compat.js";
import { parseJobRunsOn } from "../../workflow/workflow-parser.js";
import { createRunDirectories } from "../directory-setup.js";
import { prepareWorkspace } from "../workspace.js";
import { writeGitShim } from "../git-shim.js";

import { checkSmolvmHost } from "./host-capability.js";
import { resolveSmolvmImage } from "./image-mapping.js";
import {
  createAndStart,
  execScript,
  exec as smolvmExec,
  stop as smolvmStop,
  destroy as smolvmDestroy,
  packImageIfMissing,
} from "./smolvm.js";

// ─── Tunables (env-overridable) ───────────────────────────────────────────────

// smolvm 0.5.19's state DB is a single-writer SQLite; concurrent
// create/start/stop/delete calls fail with "Database already open. Cannot
// acquire lock." Default to 1 so the orchestrator serializes lifecycle ops;
// once smolvm fixes its locking the env var lets users opt back into parallel.
const SMOLVM_CONCURRENCY = parseInt(process.env.AGENT_CI_SMOLVM_CONCURRENCY || "1", 10);

// smolvm uses libkrun's TSI: the guest has no virtual NIC, but outbound
// connections are proxied through the host's network stack. A connection to
// 127.0.0.1 from inside the guest lands on the host's 127.0.0.1 — so the DTU
// (which binds 0.0.0.0) is reachable at "127.0.0.1" from the guest's POV.
// (10.0.2.2 — the libkrun-user-mode-net default — does NOT work under TSI;
// it times out. Verified against smolvm 0.5.19.)
const VM_HOST_IP = process.env.AGENT_CI_SMOLVM_HOST_IP || "127.0.0.1";

// Where the actions-runner image expects its workspace. The upstream image
// (ghcr.io/actions/actions-runner) installs run.sh at /home/runner.
const VM_RUNNER_DIR = process.env.AGENT_CI_SMOLVM_RUNNER_DIR || "/home/runner";
const VM_RUNNER_WORK_DIR = `${VM_RUNNER_DIR}/_work`;

// ─── Tiny semaphore (kept inline to avoid pulling the macos-vm one) ───────────

interface Semaphore {
  acquire(): Promise<() => void>;
}

function createSemaphore(limit: number): Semaphore {
  const safe = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  let active = 0;
  const waiters: Array<() => void> = [];
  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };
  return {
    acquire(): Promise<() => void> {
      if (active < safe) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => resolve(release));
      });
    },
  };
}

const semaphore = createSemaphore(SMOLVM_CONCURRENCY);

// ─── Entrypoint ───────────────────────────────────────────────────────────────

export async function executeSmolvmJob(job: Job): Promise<JobResult> {
  const host = checkSmolvmHost();
  if (!host.supported) {
    throw new Error(
      `smolvm runner unavailable: ${host.reason}${host.hint ? `\n  ${host.hint}` : ""}`,
    );
  }

  const release = await semaphore.acquire();
  const startTime = Date.now();

  const { name, runDir, logDir, debugLogPath } = createLogContext(
    "agent-ci-smolvm",
    job.runnerName,
  );
  job.runnerName = name;
  writeJobMetadata({ logDir, containerName: name, job });
  const debugStream = fs.createWriteStream(debugLogPath);
  const debug = (line: string) => {
    debugRunner(line);
    debugStream.write(line + "\n");
  };

  const bootStart = Date.now();
  const bt = (label: string, since: number) => {
    debugBoot(`${name} ${label}: ${Date.now() - since}ms`);
    return Date.now();
  };

  // ── Resolve image up front so we fail fast on unknown labels ──────────────
  const labels = job.workflowPath ? parseJobRunsOn(job.workflowPath, job.taskId ?? "") : [];
  const kind = classifyRunsOn(labels);
  if (kind !== "linux" && kind !== "other") {
    throw new Error(
      `executeSmolvmJob called for a ${kind} job (labels: ${JSON.stringify(labels)}). ` +
        "This is a routing bug — only Linux/other jobs should reach this path.",
    );
  }
  const { image, exact } = resolveSmolvmImage(labels);
  if (!exact) {
    process.stderr.write(
      `\nwarning: could not map runs-on ${JSON.stringify(labels)} to a known smolvm image.\n` +
        `         Falling back to ${image}. Override with AGENT_CI_SMOLVM_IMAGE if needed.\n\n`,
    );
  }

  // ── Start the ephemeral DTU on the host ───────────────────────────────────
  let t0 = Date.now();
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  const dtu = await startEphemeralDtu(dtuCacheDir);
  const dtuHostUrl = dtu.url;
  const dtuVmUrl = `http://${VM_HOST_IP}:${dtu.port}`;
  t0 = bt("dtu-start", t0);

  let vmName: string | null = null;
  const tmpRunnerCredsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-ci-smolvm-creds-"));

  const signalCleanup = () => {
    if (vmName) {
      smolvmStop(vmName).catch(() => {});
      smolvmDestroy(vmName).catch(() => {});
    }
  };
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);
  process.on("SIGHUP", signalCleanup);

  try {
    // ── Seed the job to the DTU ─────────────────────────────────────────────
    await fetch(`${dtuHostUrl}/_dtu/start-runner`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runnerName: name,
        logDir,
        timelineDir: logDir,
        virtualCachePatterns: [],
      }),
    }).catch(() => {
      /* non-fatal */
    });

    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;
    const seededSteps = appendOutputCaptureStep(job.steps ?? []);

    const seedResponse = await fetch(`${dtuHostUrl}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        ...job,
        steps: seededSteps,
        repository: overriddenRepository,
        runnerOs: "Linux",
        runnerArch: process.arch === "arm64" ? "ARM64" : "X64",
        runnerWorkDir: VM_RUNNER_WORK_DIR,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }
    t0 = bt("dtu-seed", t0);

    // ── Build the same per-run dirs the Docker path uses so workflows that
    //    use actions/checkout, setup-node, setup-pnpm, etc. find the workspace,
    //    git shim, tool cache, and PM caches at the paths they expect. ─────
    const dirs = createRunDirectories({
      runDir,
      githubRepo: job.githubRepo!,
      workflowPath: job.workflowPath,
    });

    // Write the git shim and prepare the workspace BEFORE mounting — virtiofs
    // sees current host contents at mount time, and the runner will reach for
    // /tmp/agent-ci-shims/git on first checkout.
    writeGitShim(dirs.shimsDir, job.realHeadSha ?? job.headSha ?? "0000000");
    await prepareWorkspace({
      workflowPath: job.workflowPath,
      headSha: job.headSha,
      githubRepo: job.githubRepo,
      workspaceDir: dirs.workspaceDir,
    }).catch((err) => debug(`prepareWorkspace failed (non-fatal): ${err}`));
    t0 = bt("workspace-ready", t0);

    // ── Write runner credentials BEFORE mounting (virtiofs sees current
    //    contents at mount time; we want them present from the first exec). ─
    const repoUrl = `${dtuVmUrl}/${job.githubRepo}`;
    writeRunnerCredentials(tmpRunnerCredsDir, name, repoUrl);

    // ── Pre-pack the image (idempotent) so each VM creates from a local
    //    .smolmachine artifact instead of pulling from the registry. Avoids a
    //    per-VM ~4GB pull and dodges a smolvm 0.5.19 issue where repeated
    //    registry pulls cause TSI DNS to go unreachable across the host. ──
    const packDir = path.resolve(getWorkingDirectory(), "cache", "smolvm-packs");
    const packBase = path.join(packDir, imageToPackBasename(image));
    const packPath = await packImageIfMissing(image, packBase);
    t0 = bt("smolvm-pack-ready", t0);

    // ── Mount set mirrors `buildContainerBinds` from the Docker path, minus
    //    Docker-specific bits (no /var/run/docker.sock — DinD inside smolvm
    //    is out of scope). virtiofs only mounts directories. ────────────────
    const repoName = job.githubRepo!.split("/").pop() || "repo";
    const volumes: string[] = [
      `${tmpRunnerCredsDir}:/runner-credentials:ro`,
      // logDir mounted at the same path so the in-VM tee target
      // (${logDir}/run.log) writes to a host-readable file.
      `${logDir}:${logDir}`,
      `${dirs.containerWorkDir}:${VM_RUNNER_WORK_DIR}`,
      `${dirs.shimsDir}:/tmp/agent-ci-shims`,
      `${dirs.diagDir}:${VM_RUNNER_DIR}/_diag`,
      // toolcache deliberately NOT mounted: setup-node writes ~30k small
      // files into /opt/hostedtoolcache, and virtiofs over libkrun hangs on
      // sustained small-file writes (smolvm 0.5.19). Letting the cache live
      // on the in-VM overlay disk avoids the hang at the cost of re-extracting
      // node per VM. Toggle back on via AGENT_CI_SMOLVM_MOUNT_TOOLCACHE=1.
      ...(process.env.AGENT_CI_SMOLVM_MOUNT_TOOLCACHE === "1"
        ? [`${dirs.toolCacheDir}:/opt/hostedtoolcache`]
        : []),
      `${dirs.playwrightCacheDir}:${VM_RUNNER_DIR}/.cache/ms-playwright`,
      `${dirs.warmModulesDir}:${VM_RUNNER_WORK_DIR}/${repoName}/${repoName}/node_modules`,
    ];
    if (dirs.pnpmStoreDir) {
      volumes.push(`${dirs.pnpmStoreDir}:${VM_RUNNER_WORK_DIR}/.pnpm-store`);
    }
    if (dirs.npmCacheDir) {
      volumes.push(`${dirs.npmCacheDir}:${VM_RUNNER_DIR}/.npm`);
    }
    if (dirs.bunCacheDir) {
      volumes.push(`${dirs.bunCacheDir}:${VM_RUNNER_DIR}/.bun`);
    }

    // ── Boot the VM from the pack with all bind mounts ──────────────────────
    vmName = `agent-ci-smolvm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await createAndStart(
      vmName,
      { fromPack: packPath },
      {
        network: true,
        volumes,
      },
    );
    t0 = bt("smolvm-create-start", t0);

    // Wait for the VM to be exec-ready by retrying a no-op a few times.
    await waitForExec(vmName, debug);
    t0 = bt("smolvm-exec-ready", t0);

    // ── Install creds + git shim + perms inside the VM ──────────────────────
    // - cp -a uses `.` source so dotfiles (.runner / .credentials / ...) come
    //   along; bare `*` glob would skip them.
    // - Swap /usr/bin/git ↔ /usr/bin/git.real and drop the shim in place so
    //   actions/checkout sees the pre-populated workspace instead of cloning.
    // - chown _work + _diag because the runner runs as the unprivileged
    //   `runner` user and virtiofs mounts come up root-owned.
    await execScript(
      vmName,
      `set -e
mkdir -p ${VM_RUNNER_DIR} ${VM_RUNNER_WORK_DIR} ${VM_RUNNER_DIR}/_diag
cp -a /runner-credentials/. ${VM_RUNNER_DIR}/
if [ -f /usr/bin/git ] && [ ! -f /usr/bin/git.real ]; then
  mv /usr/bin/git /usr/bin/git.real
  cp -p /tmp/agent-ci-shims/git /usr/bin/git
  chmod +x /usr/bin/git
fi
chown -R runner:runner ${VM_RUNNER_DIR} ${VM_RUNNER_WORK_DIR} ${VM_RUNNER_DIR}/_diag
chmod -R u+rwX ${VM_RUNNER_WORK_DIR}`,
      { timeoutMs: 60_000 },
    );
    t0 = bt("creds-shim-installed", t0);

    // ── Kick off ./run.sh ────────────────────────────────────────────────────
    // Redirect stdout/stderr to a virtiofs-mounted log file *inside* the VM
    // instead of letting it stream back over smolvm's vsock exec channel.
    // The .NET runner prints heavily during setup-* steps and Console.WriteLine
    // blocks when its 64K pipe buffer fills; if smolvm's vsock host-side reader
    // can't drain fast enough the runner deadlocks. Writing to a file
    // sidesteps the entire backpressure path. We tail the file from the host
    // for live debug log streaming.
    const inVmRunLog = `${logDir}/run.log`;
    const inVmDiagLog = `${logDir}/in-vm-diag.log`;
    const runScript = `set -e
cd ${VM_RUNNER_DIR}
chmod +x run.sh
# Side watcher: dump process / network / runner-status snapshot every 5s to
# a host-readable file so we can see what's happening during a hang.
(
  while true; do
    {
      echo "=== $(date -u +%H:%M:%S) ==="
      echo "--- ps (runner-related) ---"
      ps -eo pid,ppid,stat,etime,cmd | grep -E 'Runner|run.sh|node|npm|yarn|dotnet' | grep -v grep | head -30 || true
      echo "--- ss (tcp) ---"
      ss -tnp 2>/dev/null | head -20 || netstat -tnp 2>/dev/null | head -20 || true
      echo "--- meminfo ---"
      grep -E 'MemAvailable|MemFree|Active' /proc/meminfo 2>/dev/null | head -5 || true
    } >>${inVmDiagLog} 2>&1
    sleep 5
  done
) &
WATCHER_PID=$!
trap "kill $WATCHER_PID 2>/dev/null" EXIT
exec runuser -u runner -- ./run.sh --once >${inVmRunLog} 2>&1
`;
    debug(`Starting ./run.sh inside smolvm ${vmName}`);
    bt("total-boot", bootStart);

    // Tail the in-VM log file (virtiofs-backed, host-readable) so live debug
    // output keeps flowing while the runner runs.
    const tailAbort = new AbortController();
    const tailPromise = tailFileToStream(inVmRunLog, debugStream, tailAbort.signal);

    const runResult = await execScript(vmName, runScript, {
      timeoutMs: 3_600_000, // 1h hard cap
    });
    tailAbort.abort();
    await tailPromise.catch(() => {});

    await new Promise<void>((resolve) => debugStream.end(resolve));

    // ── Assemble the JobResult from timeline + outputs ──────────────────────
    const timelinePath = path.join(logDir, "timeline.json");
    const outputsFile = path.join(logDir, "outputs.json");
    let stepOutputs: Record<string, string> = {};
    if (fs.existsSync(outputsFile)) {
      try {
        stepOutputs = JSON.parse(fs.readFileSync(outputsFile, "utf-8"));
      } catch {
        /* best-effort */
      }
    }

    const lastFailedStep = readLastFailedStep(timelinePath);
    const isBooting = !fs.existsSync(timelinePath);
    const jobSucceeded = isJobSuccessful({
      lastFailedStep,
      containerExitCode: runResult.code,
      isBooting,
    });

    return buildJobResult({
      containerName: name,
      job,
      startTime,
      jobSucceeded,
      lastFailedStep,
      containerExitCode: runResult.code,
      timelinePath,
      logDir,
      debugLogPath,
      stepOutputs,
    });
  } finally {
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
    process.removeListener("SIGHUP", signalCleanup);

    if (vmName) {
      await smolvmStop(vmName).catch(() => {});
      await smolvmDestroy(vmName).catch(() => {});
    }

    await dtu.close().catch(() => {});
    await fsp.rm(tmpRunnerCredsDir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

// Poll a host-readable file (the VM writes here via virtiofs) and forward any
// newly-appended bytes to `out`. Stops when `signal` aborts.
async function tailFileToStream(
  filePath: string,
  out: NodeJS.WritableStream,
  signal: AbortSignal,
): Promise<void> {
  let pos = 0;
  while (!signal.aborted) {
    try {
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && stat.size > pos) {
        const fh = await fsp.open(filePath, "r");
        try {
          const buf = Buffer.alloc(stat.size - pos);
          await fh.read(buf, 0, buf.length, pos);
          out.write(buf);
          pos = stat.size;
        } finally {
          await fh.close();
        }
      }
    } catch {
      // best-effort
    }
    await new Promise((res) => setTimeout(res, 500));
  }
}

async function waitForExec(name: string, debug: (line: string) => void): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastErr = "";
  while (Date.now() < deadline) {
    const r = await smolvmExec(name, ["true"], { timeoutMs: 5000 }).catch((e) => ({
      code: -1,
      stdout: "",
      stderr: String(e),
    }));
    if (r.code === 0) {
      return;
    }
    lastErr = (r.stderr || "").trim();
    await new Promise((res) => setTimeout(res, 1000));
  }
  debug(`waitForExec last error: ${lastErr}`);
  throw new Error(`Timed out waiting for smolvm VM ${name} to become exec-ready`);
}

// Filesystem-safe basename for the pack file. We just need a stable, unique-
// per-image string; replace registry punctuation that breaks file paths.
function imageToPackBasename(image: string): string {
  return image.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function readLastFailedStep(timelinePath: string): string | null {
  if (!fs.existsSync(timelinePath)) {
    return null;
  }
  try {
    const records = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as any[];
    const failed = records
      .filter((r) => r.type === "Task" && (r.result || "").toLowerCase() === "failed")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return failed.length > 0 ? failed[failed.length - 1].name : null;
  } catch {
    return null;
  }
}
