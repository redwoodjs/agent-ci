import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { config } from "./config.js";
import { Job } from "./types.js";
import { createLogContext, finalizeLog, getWorkingDirectory } from "./logger.js";
import { copyWorkspace, computeLockfileHash } from "./cleanup.js";
import { minimatch } from "minimatch";
import {
  startServiceContainers,
  cleanupServiceContainers,
  type ServiceContext,
} from "./service-containers.js";
import { killRunnerContainers } from "./shutdown.js";
import { startEphemeralDtu } from "dtu-github-actions/src/ephemeral.js";

// ─── ANSI / log-level patterns ────────────────────────────────────────────────

/** Strip ANSI/VT100 escape sequences so regexes work on clean text. */
// Use RegExp constructor to avoid no-control-regex lint warning for ESC (\x1b)
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}(?:\\[[0-9;]*[A-Za-z]|[=?][0-9;]*)`, "g");
const strip = (s: string) => s.replace(ANSI_RE, "");

/** `[RUNNER … INFO …]` or `[WORKER … INFO …]` */
const RUNNER_INFO = /^\[(?:RUNNER|WORKER) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z INFO/;
/** `[RUNNER … WARN …]` */
const RUNNER_WARN = /^\[(?:RUNNER|WORKER) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z WARN/;
/** `[RUNNER … ERR …]` or `[WORKER … ERR …]` */
const RUNNER_ERR = /^\[(?:RUNNER|WORKER) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z ERR/;
/** DTU service noise */
const DTU_NOISE = /^\[DTU\] Handling (?:service discovery|pools request):/;

/**
 * Known-harmless runner errors that we suppress from user output.
 * These are expected artefacts of the local DTU setup, not real failures.
 */
const KNOWN_NOISE_ERRORS = [
  // Service-name calculation fails because our local URL isn't github.com
  /SystemDControlManager/,
  /Cannot find GitHub repository\/organization name from server url/,
  /WRITE ERROR: Cannot find GitHub repository/,
  // Expected unimplemented API endpoints in local DTU
  /VssResourceNotFoundException/,
  /AppendTimelineRecordFeedAsync/,
  /ProcessWebConsoleLinesQueueAsync/,
  /ProcessFilesUploadQueueAsync/,
  /UploadFile/,
  // DTU payload format mismatch (StringToken vs MappingToken) — not a user workflow issue
  /Unexpected type 'StringToken' encountered/,
  /The type 'MappingToken' was expected/,
  /JobExtension.*Initialization/,
  /Job initialize failed/,
  /Caught exception from InitializeJob/,
  // Stack trace lines from any of the above
  /^\[(?:RUNNER|WORKER) [^\]]+ERR\s+[^\]]+\]\s+at /,
  // All JobServerQueue errors are internal best-effort processing (feed, upload, timeline)
  /JobServerQueue/,
];

// ─── Phase-based filter ───────────────────────────────────────────────────────

/**
 * The runner goes through these phases in order:
 *   config  → "Running job:" → running → "Job X completed" → done
 *
 * We only show bare step output during the "running" phase.
 * Status milestones (√ lines, timestamps, job completed) are shown always.
 */
type Phase = "config" | "running" | "done";

function makeFilter(debug: boolean) {
  let phase: Phase = "config";
  let jobResult: string | null = null;

  function filterLine(raw: string): boolean {
    if (debug) {
      return true;
    }

    const line = strip(raw).trimEnd();

    // ── Phase transitions ────────────────────────────────────────────────────
    // The runner emits phase markers in two ways:
    //   1. Bare:    "2026-02-19 19:07:47Z: Running job: local-job"
    //   2. Wrapped: "[RUNNER … INFO Terminal] WRITE LINE: 2026-02-19 … Running job: …"
    // We always update phase from either form, but only SHOW the bare form.
    const isRunningJob = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z: Running job:/.test(line);
    const jobDoneMatch = line.match(
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z: Job .+ completed with result: (\S+)/,
    );
    const isJobDone = jobDoneMatch !== null;

    if (isRunningJob) {
      phase = "running";
    }
    if (jobDoneMatch) {
      phase = "done";
      jobResult = jobDoneMatch[1]; // e.g. "Succeeded" or "Failed"
    }

    // ── Always suppress RUNNER/WORKER INFO and WARN ──────────────────────────
    if (RUNNER_INFO.test(line)) {
      return false;
    }
    if (RUNNER_WARN.test(line)) {
      return false;
    }
    if (DTU_NOISE.test(line)) {
      return false;
    }

    // ── Suppress known-harmless errors ───────────────────────────────────────
    if (RUNNER_ERR.test(line)) {
      return !KNOWN_NOISE_ERRORS.some((re) => re.test(line));
    }

    // ── Phase-gated bare output ──────────────────────────────────────────────
    // Lines with no [RUNNER/WORKER/DTU/OA] prefix are bare output.
    const isRunnerPrefixed = /^\[(?:RUNNER|WORKER|DTU|OA)[\s\]]/.test(line);
    if (!isRunnerPrefixed) {
      // Phase milestone lines (bare form) are always shown
      if (isRunningJob || isJobDone) {
        return true;
      }
      // All other bare lines only shown during step execution
      return phase === "running";
    }

    return true;
  }

  /** Returns the result string captured from the "completed with result:" line. */
  filterLine.getJobResult = () => jobResult;

  return filterLine;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function isDebug(): boolean {
  const pattern = process.env.DEBUG || "";
  return minimatch("runner", pattern) || minimatch("runner:*", pattern);
}

// ─── Docker setup ─────────────────────────────────────────────────────────────

const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
const dockerConfig = dockerHost.startsWith("unix://")
  ? { socketPath: dockerHost.replace("unix://", "") }
  : { host: dockerHost, protocol: "ssh" as const };

const docker = new Docker(dockerConfig);

const IMAGE = "ghcr.io/actions/actions-runner:latest";

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function executeLocalJob(job: Job): Promise<void> {
  const debug = isDebug();
  const filterLine = makeFilter(debug);

  // ── Pre-flight: verify Docker is reachable ────────────────────────────────
  try {
    await docker.ping();
  } catch (err: any) {
    const isSocket = err?.code === "ECONNREFUSED" || err?.code === "ENOENT";
    const hint = isSocket
      ? "Docker does not appear to be running."
      : `Docker is not reachable: ${err?.message || err}`;
    throw new Error(
      `${hint}\n` +
        "\n" +
        "  To fix this:\n" +
        "    1. Start your Docker runtime (OrbStack, Docker Desktop, etc.)\n" +
        "    2. Wait for the engine to be ready\n" +
        "    3. Re-run the workflow\n",
    );
  }

  // 3. Prepare directories (done first so containerName is available for the header)
  const {
    name: containerName,
    runDir,
    logDir,
    outputLogPath,
    debugLogPath,
  } = createLogContext("machinen", job.runnerName);

  // Start an ephemeral in-process DTU for this job run so each job gets its
  // own isolated DTU instance on a random port — eliminating port conflicts.
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  const ephemeralDtu = await startEphemeralDtu(dtuCacheDir).catch(() => null);
  const dtuUrl = ephemeralDtu?.url ?? config.GITHUB_API_URL;

  const stepOutputPath = path.join(logDir, "step-output.log");
  await fetch(`${dtuUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerName: containerName,
      logDir,
      timelineDir: logDir,
      // The pnpm store is bind-mounted into the container, so there's no need
      // for the runner to tar/gzip it. Tell the DTU to return a synthetic hit
      // for any cache key containing "pnpm" — skipping the 60s+ tar entirely.
      virtualCachePatterns: ["pnpm"],
    }),
  }).catch(() => {
    /* non-fatal */
  });

  // Write metadata if available (to help the UI map logs to workflows)
  if (job.workflowPath) {
    const metadataPath = path.join(logDir, "metadata.json");
    // Derive repoPath from the workflow file (walk up to find .git)
    let repoPath = "";
    {
      let dir = path.dirname(job.workflowPath);
      while (dir !== "/" && !fs.existsSync(path.join(dir, ".git"))) {
        dir = path.dirname(dir);
      }
      repoPath = dir !== "/" ? dir : "";
    }
    // If the orchestrator (or retryRun) already wrote a metadata.json with the
    // correct workflowRunId, honour it. This is critical for retries of multi-job
    // runs (e.g. oa-runner-125-001-001) where a naive regex would strip only a
    // single suffix and produce the wrong group key.
    let workflowRunId: string | undefined;
    let attempt: number | undefined;
    // Preserve the jobName written by the orchestrator (e.g. "Shard (1/3)") so
    // human-readable labels aren't overwritten with the raw taskId on process start.
    let existingJobName: string | null = null;
    if (fs.existsSync(metadataPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
        workflowRunId = existing.workflowRunId;
        attempt = existing.attempt;
        if (existing.jobName !== undefined) {
          existingJobName = existing.jobName;
        }
      } catch {
        // Fall through to derivation
      }
    }
    if (!workflowRunId) {
      // Derive workflowRunId (group key) by stripping job/matrix/retry suffixes.
      // e.g. machinen-redwoodjssdk-14-j1-m2-r2 → machinen-redwoodjssdk-14
      workflowRunId = containerName.replace(/(-j\d+)?(-m\d+)?(-r\d+)?$/, "");
    }
    // Build our fields; we'll merge them ON TOP of whatever the orchestrator wrote
    // so that matrixContext, warmCache, repoPath, etc. are preserved.
    const freshFields: Record<string, any> = {
      workflowPath: job.workflowPath,
      workflowName: path.basename(job.workflowPath, path.extname(job.workflowPath)),
      // Prefer the orchestrator-written label; fall back to raw taskId
      jobName: existingJobName !== null ? existingJobName : (job.taskId ?? null),
      workflowRunId,
      commitId: job.headSha || "WORKING_TREE",
      date: Date.now(),
      taskId: job.taskId,
      attempt: attempt ?? 1,
    };
    // Only overwrite repoPath if we actually found a .git root; otherwise keep
    // the orchestrator's value (which is always correct for temp-dir tests too).
    if (repoPath) {
      freshFields.repoPath = repoPath;
    }
    // Read back existing metadata (already parsed above) to preserve
    // orchestrator-written fields like matrixContext, warmCache, etc.
    let existingMeta: Record<string, any> = {};
    if (fs.existsSync(metadataPath)) {
      try {
        existingMeta = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      } catch {}
    }
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ ...existingMeta, ...freshFields }, null, 2),
      "utf-8",
    );
  }
  // Open output stream immediately so header + footer lines are captured in the log
  const outputStream = fs.createWriteStream(outputLogPath);
  const debugStream = fs.createWriteStream(debugLogPath);
  /** Write a line to stdout and output.log. */
  const emit = (line: string) => {
    process.stdout.write(line + "\n");
    outputStream.write(line + "\n");
  };

  // ── Compact job header ──────────────────────────────────────────────────────
  const shortSha = job.headSha ? ` (${job.headSha.substring(0, 7)})` : "";
  emit(
    `\n  Using: ${job.headSha ? `SHA ${job.headSha} (${job.shaRef ?? "HEAD"})` : "working directory (dirty files included)"} · ${containerName}`,
  );
  emit(`\n  ┌─ Job: ${job.githubRepo}${shortSha}`);
  if (job.steps?.length) {
    const names = job.steps.map((s: any) => s.Name || s.name).join(", ");
    emit(`  │  Steps: ${names}`);
  }
  emit(`  └─ Delivery: ${job.deliveryId}\n`);

  // Per-run dirs (work, shims, diag) are now co-located under the run's directory.
  // This lets cleanup be a single `rm -rf <runDir>` removing everything for that run.
  const workDir = getWorkingDirectory();
  const containerWorkDir = path.resolve(runDir, "work");
  const shimsDir = path.resolve(runDir, "shims");
  const diagDir = path.resolve(runDir, "diag");
  // Shared caches: live under <workDir>/cache/ and are intentionally shared across all runners.
  const toolCacheDir = path.resolve(workDir, "cache", "toolcache");
  const repoSlug = (job.githubRepo || config.GITHUB_REPO).replace("/", "-");
  const pnpmStoreDir = path.resolve(workDir, "cache", "pnpm-store", repoSlug);
  const playwrightCacheDir = path.resolve(workDir, "cache", "playwright", repoSlug);
  // Warm node_modules: a persistent bind-mount keyed by the pnpm lockfile hash.
  // First run: pnpm install writes into this directory through the bind-mount.
  // Subsequent runs: pnpm install finds node_modules already populated → NOP.
  // The wave scheduler serializes the first job when the dir is empty so only
  // one container runs pnpm install at a time (see runner.ts).
  let lockfileHash = "no-lockfile";
  try {
    let repoRootForHash: string | undefined;
    if (job.workflowPath) {
      let dir = path.dirname(job.workflowPath);
      while (dir !== "/" && !fs.existsSync(path.join(dir, ".git"))) {
        dir = path.dirname(dir);
      }
      if (dir !== "/") {
        repoRootForHash = dir;
      }
    }
    if (repoRootForHash) {
      lockfileHash = computeLockfileHash(repoRootForHash);
    }
  } catch {
    // Best-effort; fall back to "no-lockfile"
  }
  const warmModulesDir = path.resolve(workDir, "cache", "warm-modules", repoSlug, lockfileHash);
  // Place workspace files directly in containerWorkDir/<repo>/<repo>/ so the
  // runner finds them at /home/runner/_work/<repo>/<repo>/ via bind-mount.
  // This eliminates the container-side cp -r (Copy 2) entirely.
  const repoName = (job.githubRepo || config.GITHUB_REPO).split("/").pop() || "repo";
  const workspaceDir = path.resolve(containerWorkDir, repoName, repoName);

  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(containerWorkDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(diagDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(toolCacheDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(pnpmStoreDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(playwrightCacheDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(warmModulesDir, { recursive: true, mode: 0o777 });
  // Ensure all intermediate dirs are world-writable for DinD scenarios where
  // the supervisor runs as root but nested containers use runner user (UID 1001)
  try {
    fs.chmodSync(containerWorkDir, 0o777);
    fs.chmodSync(workspaceDir, 0o777);
    fs.chmodSync(shimsDir, 0o777);
    fs.chmodSync(diagDir, 0o777);
    fs.chmodSync(toolCacheDir, 0o777);
    fs.chmodSync(pnpmStoreDir, 0o777);
    fs.chmodSync(playwrightCacheDir, 0o777);
    fs.chmodSync(warmModulesDir, 0o777);
  } catch {
    // Ignore chmod errors (non-critical)
  }

  // Signal handler: ensure cleanup runs even when killed.
  // Kills the Docker container + any service sidecars + network, then removes temp dirs.
  // Use process.once so multiple calls to executeLocalJob() don't accumulate listeners.
  const signalCleanup = () => {
    // Force-kill Docker containers (sync so it works in signal handlers)
    killRunnerContainers(containerName);
    for (const d of [containerWorkDir, shimsDir, diagDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    process.exit(1);
  };
  process.once("SIGINT", signalCleanup);
  process.once("SIGTERM", signalCleanup);
  try {
    // 1. Seed the job to Local DTU
    // Build a corrected repository object from job.githubRepo (which is resolved from the git
    // remote — e.g. "redwoodjs/sdk") so generators.ts uses the right repo name for checkout /
    // workspace paths, rather than the webhook event repo that may point to opposite-actions.
    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;

    const seedResponse = await fetch(`${dtuUrl}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "local-job",
        status: "queued",
        localPath: workspaceDir,
        ...job,
        // Override repository with the git-remote-resolved repo (takes precedence over ...job spread)
        repository: overriddenRepository,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }

    // 2. Registration token (mock for local)
    const registrationToken = "mock_local_token";

    // 4. Prepare workspace (checkout emulation)
    try {
      // Resolve repo root — needed for both archive and rsync paths.
      // Derive from the workflow path (which lives inside the target repo) so we copy
      // from the correct repo, not from the supervisor's CWD (which is oa-1).
      let repoRoot: string | undefined;
      if (job.workflowPath) {
        let dir = path.dirname(job.workflowPath);
        while (dir !== "/" && !fs.existsSync(path.join(dir, ".git"))) {
          dir = path.dirname(dir);
        }
        if (dir !== "/") {
          repoRoot = dir;
        }
      }
      if (!repoRoot) {
        repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
      }

      if (job.headSha && job.headSha !== "HEAD") {
        // Specific SHA requested — use git archive (clean snapshot)
        execSync(`git archive ${job.headSha} | tar -x -C ${workspaceDir}`, {
          stdio: "pipe",
          cwd: repoRoot,
        });
      } else {
        // Default: copy the working directory as-is, including dirty/untracked files.
        // Uses git ls-files to respect .gitignore (avoids copying node_modules, _/, etc.)
        // On macOS: per-file APFS CoW clones. On Linux: rsync. Fallback: fs.cpSync.
        copyWorkspace(repoRoot, workspaceDir);
      }

      // Add fake git repo so actions/checkout can use the existing workspace.
      // The remote URL must exactly match what actions/checkout computes via URL.origin.
      // Node.js URL.origin strips the default port (80), so we must NOT include :80.
      execSync(`git init`, { cwd: workspaceDir });
      execSync(`git config user.name "oa"`, { cwd: workspaceDir });
      execSync(`git config user.email "oa@example.com"`, { cwd: workspaceDir });
      execSync(`git remote add origin http://127.0.0.1/${job.githubRepo || config.GITHUB_REPO}`, {
        cwd: workspaceDir,
      });
      execSync(`git add . && git commit -m "workspace" || true`, { cwd: workspaceDir });
      // Create main and refs/remotes/origin/main pointing to this commit
      execSync(`git branch -M main`, { cwd: workspaceDir });
      execSync(`git update-ref refs/remotes/origin/main HEAD`, { cwd: workspaceDir });
      // Detach HEAD so checkout can freely delete ALL branches (it can't delete the current branch)
      execSync(`git checkout --detach HEAD`, { cwd: workspaceDir });
    } catch (err) {
      if (debug) {
        console.warn(`[LocalJob] Failed to prepare workspace: ${err}. Using host fallback.`);
      }
    }

    // 5. Git shim
    // The SHA returned by ls-remote must match github.sha in the job definition
    // so actions/checkout's SHA validation passes. Use the same SHA that the DTU
    // will use in the job definition (OA_HEAD_SHA env var or the deterministic fake).
    const fakeSha =
      job.headSha && job.headSha !== "HEAD"
        ? job.headSha
        : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const gitShimPath = path.join(shimsDir, "git");
    fs.writeFileSync(
      gitShimPath,
      `#!/bin/bash

# Log every call for debugging
echo "git $*" >> /home/runner/_diag/oa-git-calls.log

# actions/checkout probes the remote URL via config.
# It computes the expected URL using URL.origin, which strips the default port 80.
# So we must return the URL WITHOUT :80 to match.
if [[ "$*" == *"config --local --get remote.origin.url"* || "$*" == *"config --get remote.origin.url"* ]]; then
  echo "https://github.com/\${GITHUB_REPOSITORY}"
  exit 0
fi

# actions/checkout probes ls-remote to find the target SHA.
# Return the same SHA that github.sha uses in the job definition.
if [[ "$*" == *"ls-remote"* ]]; then
  echo "${fakeSha}\tHEAD"
  echo "${fakeSha}\trefs/heads/main"
  exit 0
fi

# Intercept fetch - we don't have a real git server, so fetch is a no-op.
# But we must create refs/remotes/origin/main so checkout's post-fetch validation passes.
if [[ "$*" == *"fetch"* ]]; then
  echo "[OA Shim] Intercepted 'fetch' - workspace is pre-populated."
  /usr/bin/git.real update-ref refs/remotes/origin/main HEAD 2>/dev/null || true
  exit 0
fi

# Redirect: git checkout ... refs/remotes/origin/main -> create local main from HEAD.
# Note: actions/checkout deletes the local 'main' branch before fetching, so we cannot
# checkout the local branch - instead we recreate it from the current HEAD commit.
if [[ "$*" == *"checkout"* && "$*" == *"refs/remotes/origin/"* ]]; then
  echo "[OA Shim] Redirecting remote checkout - recreating main from HEAD."
  /usr/bin/git.real checkout -B main HEAD
  exit $?
fi

# Intercept clean and rm which can destroy workspace files
if [[ "$1" == "clean" || "$1" == "rm" ]]; then
  echo "[OA Shim] Intercepted '$1' to protect local files."
  exit 0
fi

# Intercept rev-parse for HEAD/refs/heads/main so the SHA matches github.sha
# actions/checkout validates that refs/heads/main == github.sha after checkout
if [[ "$1" == "rev-parse" ]]; then
  for arg in "$@"; do
    if [[ "$arg" == "HEAD" || "$arg" == "refs/heads/main" || "$arg" == "refs/remotes/origin/main" ]]; then
      echo "${fakeSha}"
      exit 0
    fi
  done
  # Fall through for other rev-parse calls (e.g. rev-parse --show-toplevel)
fi

# Pass through all other git commands (checkout, reset, log, init, config, etc.)
echo "git $@ (pass-through)" >> /home/runner/_diag/oa-git-calls.log
/usr/bin/git.real "$@"
EXIT_CODE=$?
echo "git $@ exited with $EXIT_CODE" >> /home/runner/_diag/oa-git-calls.log
exit $EXIT_CODE
`,
      { mode: 0o755 },
    );

    // 6. Spawn container
    // Use the ephemeral DTU URL (random port) instead of the global config port.
    const dtuPort = new URL(dtuUrl).port || "80";
    // When running inside a Docker container (CI), nested containers can't reach the host via
    // `host.docker.internal` — that points to the Mac/host, not the CI container. We need the
    // CI container's own bridge IP so nested containers can reach the DTU running inside it.
    const isInsideDocker = fs.existsSync("/.dockerenv");
    let dtuHost = "host.docker.internal";
    if (isInsideDocker) {
      try {
        // Get the CI container's own IP on the Docker bridge network
        const ip = execSync("hostname -I 2>/dev/null | awk '{print $1}'", {
          encoding: "utf8",
        }).trim();
        if (ip) {
          dtuHost = ip;
        }
      } catch {
        dtuHost = "172.17.0.1"; // fallback to bridge gateway
      }
    }
    const dockerApiUrl = dtuUrl.replace("localhost", dtuHost).replace("127.0.0.1", dtuHost);
    const repoUrl = `${dockerApiUrl}/${job.githubRepo || config.GITHUB_REPO}`;

    if (debug) {
      console.log(`[debug] Spawning container ${containerName}...`);
    }

    // Pre-cleanup: remove any stale container with the same name to prevent 409 conflicts.
    try {
      const stale = docker.getContainer(containerName);
      await stale.remove({ force: true });
    } catch {
      // Ignore - container doesn't exist
    }

    // ── Service containers ──────────────────────────────────────────────────────
    let serviceCtx: ServiceContext | undefined;
    if (job.services && job.services.length > 0) {
      emit(`\n  Starting ${job.services.length} service container(s)...`);
      serviceCtx = await startServiceContainers(docker, job.services, containerName, emit);
      emit("");
    }

    // Build port-forward shell snippet for service containers (runs inside the runner container).
    // Each forwarder binds localhost:<port> and proxies to the service container on the Docker network.
    const svcPortForwardSnippet = serviceCtx?.portForwards.length
      ? serviceCtx.portForwards.join(" \n") + " \nsleep 0.3 && "
      : "";
    // ── Direct container injection ──────────────────────────────────────────────
    // When job.container is set, use the specified image directly and inject the
    // runner binary via bind-mount. This avoids DinD entirely.
    //
    // NOTE: The runner is a self-contained .NET app that requires glibc.
    // musl-based images (Alpine) are NOT supported. See issue #15.
    const hostWorkDir = path.resolve(getWorkingDirectory(), "work", containerName);
    const hostToolcacheDir = path.resolve(getWorkingDirectory(), "toolcache");
    // Shared seed directory — extracted once and reused across all containers.
    const hostRunnerSeedDir = path.resolve(getWorkingDirectory(), "runner");
    // Per-container copy — each container gets its own writable copy so concurrent
    // config.sh / run.sh invocations don't race on .runner / .credentials files.
    const hostRunnerDir = path.resolve(getWorkingDirectory(), `runner-${containerName}`);
    const useDirectContainer = !!job.container;
    const containerImage = useDirectContainer ? job.container!.image : IMAGE;

    // When using a custom container, we need the runner binary on the host so we
    // can bind-mount it in. Extract from the actions-runner image once into the
    // shared seed directory, then copy to a per-container directory.
    if (useDirectContainer) {
      await fs.promises.mkdir(hostRunnerSeedDir, { recursive: true });
      const markerFile = path.join(hostRunnerSeedDir, ".seeded");
      try {
        await fs.promises.access(markerFile);
      } catch {
        emit("  Extracting runner binary to host (one-time)...");
        const tmpName = `oa-seed-runner-${Date.now()}`;
        const seedContainer = await docker.createContainer({
          Image: IMAGE,
          name: tmpName,
          Cmd: ["true"],
        });
        const { execSync } = await import("node:child_process");
        execSync(`docker cp ${tmpName}:/home/runner/. "${hostRunnerSeedDir}/"`, { stdio: "pipe" });
        await seedContainer.remove();
        // Patch config.sh to skip the dependency checks (ldd/ldconfig for libicu etc.)
        // These checks fail in minimal containers. The runner binary itself works fine
        // with DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1.
        const configShPath = path.join(hostRunnerSeedDir, "config.sh");
        let configSh = await fs.promises.readFile(configShPath, "utf8");
        configSh = configSh.replace(
          /# Check dotnet Core.*?^fi$/ms,
          "# Dependency checks removed for container injection",
        );
        await fs.promises.writeFile(configShPath, configSh);
        await fs.promises.writeFile(markerFile, new Date().toISOString());
        emit("  ✔ Runner extracted.");
      }
      // Clean stale runner auth files from the seed dir itself — they can accumulate
      // from runs before the per-container runner fix, when this dir was used directly.
      for (const staleFile of [".runner", ".credentials", ".credentials_rsaparams"]) {
        try {
          fs.rmSync(path.join(hostRunnerSeedDir, staleFile));
        } catch {
          /* not present */
        }
      }
      // Copy seed to per-container directory so config.sh / run.sh don't race.
      execSync(`cp -a "${hostRunnerSeedDir}" "${hostRunnerDir}"`, { stdio: "pipe" });
      // Remove any stale runner auth files from the copy — belt-and-suspenders guard
      // in case something adds them to the seed dir in the future.
      for (const staleFile of [".runner", ".credentials", ".credentials_rsaparams"]) {
        try {
          fs.rmSync(path.join(hostRunnerDir, staleFile));
        } catch {
          /* not present */
        }
      }
    }

    // Pull the custom container image if needed
    if (useDirectContainer) {
      emit(`  Pulling ${containerImage}...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(containerImage, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) {
            return reject(err);
          }
          docker.modem.followProgress(stream, (err: Error | null) => {
            if (err) {
              return reject(err);
            }
            resolve();
          });
        });
      });
    }

    const container = await docker.createContainer({
      Image: containerImage,
      name: containerName,
      Env: [
        `RUNNER_NAME=${containerName}`,
        `RUNNER_TOKEN=${registrationToken}`,
        `RUNNER_REPOSITORY_URL=${repoUrl}`,
        `GITHUB_API_URL=${dockerApiUrl}`,
        `GITHUB_SERVER_URL=${repoUrl}`,
        `GITHUB_REPOSITORY=${job.githubRepo || config.GITHUB_REPO}`,
        `OA_LOCAL_SYNC=true`,
        `OA_HEAD_SHA=${job.headSha || "HEAD"}`,
        `OA_DTU_HOST=${dtuHost}`,
        `ACTIONS_CACHE_URL=${dockerApiUrl}/`,
        `ACTIONS_RESULTS_URL=${dockerApiUrl}/`,
        `ACTIONS_RUNTIME_TOKEN=mock_cache_token_123`,
        `RUNNER_TOOL_CACHE=/opt/hostedtoolcache`,
        `PATH=/home/runner/externals/node24/bin:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        // Custom containers may run as root and lack libicu — configure accordingly
        ...(useDirectContainer
          ? [`RUNNER_ALLOW_RUNASROOT=1`, `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`]
          : []),
      ],
      // When using a custom container, the entrypoint needs to be overridden
      // since the image's default entrypoint is not the runner.
      ...(useDirectContainer ? { Entrypoint: ["bash"] } : {}),
      Cmd: [
        ...(useDirectContainer ? ["-c"] : ["bash", "-c"]),
        // MAYBE_SUDO: use sudo if available, otherwise run directly (custom containers may not have sudo)
        `MAYBE_SUDO() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }; MAYBE_SUDO chmod -R 777 /home/runner/_work /home/runner/_diag 2>/dev/null || true && if [ -f /usr/bin/git ]; then MAYBE_SUDO mv /usr/bin/git /usr/bin/git.real 2>/dev/null; MAYBE_SUDO cp /tmp/oa-shims/git /usr/bin/git 2>/dev/null; fi && ${svcPortForwardSnippet}echo "[OA] Starting DTU proxy (port 80 -> ${dtuPort})..." && PROXY_T0=$(date +%s%3N) && node -e "
const net=require('net');
const srv=net.createServer(c=>{
  const s=net.connect(${dtuPort},'$OA_DTU_HOST',()=>{c.pipe(s);s.pipe(c)});
  s.on('error',()=>c.destroy());c.on('error',()=>s.destroy());
});
srv.listen(80,'127.0.0.1',()=>process.stdout.write(''));
" & PROXY_PID=$! && for i in $(seq 1 100); do nc -z 127.0.0.1 80 2>/dev/null && break; sleep 0.1; done && echo "[OA] DTU proxy ready in $(($(date +%s%3N) - PROXY_T0))ms" && chmod 666 /var/run/docker.sock 2>/dev/null || true && RESOLVED_URL="http://127.0.0.1:80/$GITHUB_REPOSITORY" && export GITHUB_API_URL="http://127.0.0.1:80" && export GITHUB_SERVER_URL="https://github.com" && cd /home/runner && ./config.sh remove --token "$RUNNER_TOKEN" 2>/dev/null || true && ./config.sh --url "$RESOLVED_URL" --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" --unattended --ephemeral --work _work --labels opposite-actions || echo "Config warning: Service generation failed, proceeding..." && REPO_NAME=$(basename $GITHUB_REPOSITORY) && WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME && MAYBE_SUDO chmod -R 777 $WORKSPACE_PATH 2>/dev/null || true && echo "Workspace ready (direct bind-mount): $(ls $WORKSPACE_PATH 2>/dev/null | wc -l) files" && ./run.sh --once`,
      ],
      HostConfig: {
        Binds: [
          // When using a custom container, bind-mount the extracted runner
          ...(useDirectContainer ? [`${hostRunnerDir}:/home/runner`] : []),
          `${hostWorkDir}:/home/runner/_work`,
          "/var/run/docker.sock:/var/run/docker.sock",
          `${shimsDir}:/tmp/oa-shims`,
          `${diagDir}:/home/runner/_diag`,
          `${hostToolcacheDir}:/opt/hostedtoolcache`,
          `${pnpmStoreDir}:/home/runner/_work/.pnpm-store`,
          `${playwrightCacheDir}:/home/runner/.cache/ms-playwright`,
          // Warm node_modules: pre-populated on first run, served from host on subsequent runs.
          // pnpm install inside the container writes here directly; subsequent runs find
          // node_modules already in place and exit immediately.
          `${warmModulesDir}:/home/runner/_work/${repoName}/${repoName}/node_modules`,
        ],
        AutoRemove: false,
        Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }],
        ...(serviceCtx ? { NetworkMode: serviceCtx.networkName } : {}),
      },
      Tty: true,
    });

    await container.start();

    // 7. Stream logs ─────────────────────────────────────────────────────────────
    // Use readline so we process complete lines (no split ANSI sequences).
    // Write ALL lines to debug.log; write filtered lines to output.log and stdout.
    const rawStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    // outputStream + debugStream already open from above

    // Tail step-output.log written by the DTU during job execution.
    // Runs in parallel with container log streaming; stops once container exits.
    let tailDone = false;
    const tailPromise = (async () => {
      let offset = 0;
      let partial = "";
      // Wait for file to exist (DTU creates it on start-runner)
      while (!fs.existsSync(stepOutputPath) && !tailDone) {
        await new Promise((r) => setTimeout(r, 50));
      }
      while (!tailDone) {
        try {
          const stat = fs.statSync(stepOutputPath);
          if (stat.size > offset) {
            const fd = fs.openSync(stepOutputPath, "r");
            const chunk = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, chunk, 0, chunk.length, offset);
            fs.closeSync(fd);
            offset = stat.size;
            partial += chunk.toString("utf8");
            const lines = partial.split("\n");
            partial = lines.pop() ?? "";
            for (const line of lines) {
              emit(line);
            }
          }
        } catch {
          /* file may not exist yet */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      // Flush any remaining partial line
      if (partial.trim()) {
        emit(partial);
      }
    })();

    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: rawStream, crlfDelay: Infinity });

      rl.on("line", (line) => {
        // Always write raw line to debug.log
        debugStream.write(line + "\n");
        // Write filtered lines to output.log and stdout
        if (filterLine(line)) {
          outputStream.write(line + "\n");
          process.stdout.write(line + "\n");
        }
      });

      rl.on("close", () => {
        resolve();
      });
    });

    // Stop tail now that container has finished
    tailDone = true;
    await tailPromise;

    // 8. Wait for completion (with timeout to handle runner hang in --once mode)
    const CONTAINER_EXIT_TIMEOUT_MS = 30_000;
    let waitResult: { StatusCode: number };
    try {
      waitResult = await Promise.race([
        container.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Container exit timeout")), CONTAINER_EXIT_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // Container didn't exit in time — force-stop it
      emit(
        `  ⚠ Runner did not exit within ${CONTAINER_EXIT_TIMEOUT_MS / 1000}s, force-stopping container…`,
      );
      try {
        await container.stop({ t: 5 });
      } catch {
        /* already stopped */
      }
      waitResult = await container.wait();
    }
    const containerExitCode = waitResult.StatusCode;

    // Trust the result reported in the log over the container exit code.
    const loggedResult = filterLine.getJobResult(); // e.g. "Succeeded", "Failed", or null
    const jobSucceeded =
      loggedResult !== null ? loggedResult === "Succeeded" : containerExitCode === 0;
    const exitCode = jobSucceeded ? 0 : 1;

    const icon = jobSucceeded ? "✔" : "✖";
    const label = jobSucceeded
      ? "succeeded"
      : `failed${loggedResult ? ` (result: ${loggedResult})` : ` (exit ${containerExitCode})`}`;
    emit(`\n  ${icon} Job ${label} · ${containerName}`);
    emit(`  📄 Output: file://${outputLogPath}`);
    emit(`  📄 Debug:  file://${debugLogPath}\n`);

    // Close streams now that all lines are written
    await new Promise<void>((resolve) => outputStream.end(resolve));
    await new Promise<void>((resolve) => debugStream.end(resolve));

    // Finalize log
    if (fs.existsSync(outputLogPath)) {
      finalizeLog(outputLogPath, exitCode, job.headSha, containerName);
    }

    // Cleanup
    try {
      await container.remove({ force: true });
    } catch {
      // Ignore - container may already be removed
    }
    // Clean up service containers and shared network
    if (serviceCtx) {
      await cleanupServiceContainers(docker, serviceCtx, emit);
    }
    // workspaceDir is now inside containerWorkDir — no separate cleanup needed
    if (fs.existsSync(shimsDir)) {
      fs.rmSync(shimsDir, { recursive: true, force: true });
    }
    if (fs.existsSync(diagDir)) {
      fs.rmSync(diagDir, { recursive: true, force: true });
    }
    // Clean per-container runner copy (always safe to remove)
    if (fs.existsSync(hostRunnerDir)) {
      fs.rmSync(hostRunnerDir, { recursive: true, force: true });
    }
    // Clean containerWorkDir only on success (keep failed workspaces for inspection)
    if (jobSucceeded && fs.existsSync(containerWorkDir)) {
      fs.rmSync(containerWorkDir, { recursive: true, force: true });
    }

    // Propagate failure so the orchestrator (which checks our exit code) sees it
    if (!jobSucceeded) {
      process.exit(1);
    }
  } finally {
    // Always deregister signal handlers, even if an error was thrown before the
    // normal completion path (e.g. seed failure, container start failure).
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
  }
}
