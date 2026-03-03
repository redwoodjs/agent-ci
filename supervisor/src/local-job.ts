import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { config } from "./config.js";
import { Job } from "./types.js";
import { createLogContext, finalizeLog, getWorkingDirectory } from "./logger.js";
import { minimatch } from "minimatch";
import {
  startServiceContainers,
  cleanupServiceContainers,
  type ServiceContext,
} from "./service-containers.js";

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
    outputLogPath,
    debugLogPath,
  } = createLogContext("oa-runner", job.runnerName);

  // Tell the DTU which log directory to write step output into — do this as early as
  // possible so it's ready before the runner container boots and sends feed lines.
  const dtuUrl = config.GITHUB_API_URL;
  const stepOutputPath = path.join(path.dirname(outputLogPath), "step-output.log");
  await fetch(`${dtuUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerName: containerName,
      logDir: path.dirname(outputLogPath),
      timelineDir: path.dirname(outputLogPath), // write timeline.json alongside process-stdout.log
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
    const metadataPath = path.join(path.dirname(outputLogPath), "metadata.json");
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
      // Derive workflowRunId (group key) by stripping the multi-job -NNN suffix
      // (e.g. oa-runner-95-001 → oa-runner-95). The suffix is always zero-padded 3
      // digits that follow another numeric segment, so we must NOT strip the runner
      // number itself (e.g. oa-runner-107 must stay as-is, not become oa-runner).
      workflowRunId = containerName.replace(/(?<=-\d+)-\d{3}$/, "");
    }
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          workflowPath: job.workflowPath,
          workflowName: path.basename(job.workflowPath, path.extname(job.workflowPath)),
          // Prefer the orchestrator-written label; fall back to raw taskId
          jobName: existingJobName !== null ? existingJobName : (job.taskId ?? null),
          workflowRunId,
          repoPath,
          commitId: job.headSha || "WORKING_TREE",
          date: Date.now(),
          taskId: job.taskId,
          attempt: attempt ?? 1,
        },
        null,
        2,
      ),
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

  // Move workspace prep BEFORE seed to pass localPath
  const workspaceId = Date.now();
  const workDir = getWorkingDirectory();
  const workspaceDir = path.resolve(workDir, "work", `workspace-${workspaceId}`);
  const containerWorkDir = path.resolve(workDir, "work", containerName);
  const shimsDir = path.resolve(workDir, "shims", containerName);
  const diagDir = path.resolve(workDir, "diag", containerName);
  const toolCacheDir = path.resolve(workDir, "toolcache");
  const repoSlug = (job.githubRepo || config.GITHUB_REPO).replace("/", "-");
  const pnpmStoreDir = path.resolve(workDir, "pnpm-store", repoSlug);

  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(containerWorkDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(diagDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(toolCacheDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(pnpmStoreDir, { recursive: true, mode: 0o777 });
  // Ensure all intermediate dirs are world-writable for DinD scenarios where
  // the supervisor runs as root but nested containers use runner user (UID 1001)
  try {
    fs.chmodSync(workspaceDir, 0o777);
    fs.chmodSync(containerWorkDir, 0o777);
    fs.chmodSync(shimsDir, 0o777);
    fs.chmodSync(diagDir, 0o777);
    fs.chmodSync(toolCacheDir, 0o777);
    fs.chmodSync(pnpmStoreDir, 0o777);
  } catch {
    // Ignore chmod errors (non-critical)
  }

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
      // rsync excludes .git to keep the workspace clean for the runner.
      try {
        // Preferred: rsync (fast, honours gitignore via git ls-files)
        execSync(
          `git ls-files --cached --others --exclude-standard -z | rsync -a --files-from=- --from0 ./ ${workspaceDir}/`,
          { stdio: "pipe", shell: "/bin/sh", cwd: repoRoot },
        );
      } catch {
        // Fallback: use Node.js fs.cpSync when rsync is not available (e.g. actions-runner image)
        const files = execSync(`git ls-files --cached --others --exclude-standard -z`, {
          stdio: "pipe",
          cwd: repoRoot,
        })
          .toString()
          .split("\0")
          .filter(Boolean);
        for (const file of files) {
          const src = path.join(repoRoot, file);
          const dest = path.join(workspaceDir, file);
          try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.cpSync(src, dest, { force: true, recursive: true });
          } catch {
            // Skip files that can't be copied (e.g. symlinks broken, etc.)
          }
        }
      }
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
  const dtuPort = new URL(config.GITHUB_API_URL).port || "80";
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
  const dockerApiUrl = config.GITHUB_API_URL.replace("localhost", dtuHost).replace(
    "127.0.0.1",
    dtuHost,
  );
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

  const container = await docker.createContainer({
    Image: IMAGE,
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
    ],
    Cmd: [
      "bash",
      "-c",
      `sudo -n chmod -R 777 /home/runner/_work /home/runner/_diag 2>/dev/null || true && sudo -n mv /usr/bin/git /usr/bin/git.real && sudo -n cp /tmp/oa-shims/git /usr/bin/git && ${svcPortForwardSnippet}sudo -n python3 -c "
import socket, threading, sys
def fwd(src,dst):
 try:
  while True:
   d=src.recv(65536)
   if not d: break
   dst.sendall(d)
 except: pass
 finally: src.close(); dst.close()
def handle(c):
 s=socket.socket(); s.connect(('$OA_DTU_HOST',${dtuPort})); threading.Thread(target=fwd,args=(c,s),daemon=True).start(); fwd(s,c)
srv=socket.socket(); srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); srv.bind(('127.0.0.1',80)); srv.listen(32)
while True:
 c,_=srv.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
" & sleep 0.2 && sudo chmod 666 /var/run/docker.sock 2>/dev/null || true && RESOLVED_URL="http://127.0.0.1:80/$GITHUB_REPOSITORY" && export GITHUB_API_URL="http://127.0.0.1:80" && export GITHUB_SERVER_URL="https://github.com" && ./config.sh --url "$RESOLVED_URL" --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" --unattended --ephemeral --work _work --labels opposite-actions || echo "Config warning: Service generation failed, proceeding..." && REPO_NAME=$(basename $GITHUB_REPOSITORY) && WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME && mkdir -p $WORKSPACE_PATH && (cp -r /tmp/oa-workspace/. $WORKSPACE_PATH/ 2>/dev/null && sudo -n chmod -R 777 $WORKSPACE_PATH 2>/dev/null || true && echo "Workspace ready: $(ls $WORKSPACE_PATH | wc -l) files" || echo "Workspace copy skipped - no mounted workspace") && ./run.sh --once`,
    ],
    HostConfig: {
      Binds: [
        `${path.resolve(getWorkingDirectory(), "work", containerName)}:/home/runner/_work`,
        "/var/run/docker.sock:/var/run/docker.sock",
        `${shimsDir}:/tmp/oa-shims`,
        `${diagDir}:/home/runner/_diag`,
        `${workspaceDir}:/tmp/oa-workspace`,
        `${path.resolve(getWorkingDirectory(), "toolcache")}:/opt/hostedtoolcache`,
        `${pnpmStoreDir}:/home/runner/_work/.pnpm-store`,
      ],
      AutoRemove: false,
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

  // 8. Wait for completion
  const waitResult = await container.wait();
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
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (fs.existsSync(shimsDir)) {
    fs.rmSync(shimsDir, { recursive: true, force: true });
  }
  if (fs.existsSync(diagDir)) {
    fs.rmSync(diagDir, { recursive: true, force: true });
  }

  // Propagate failure so the orchestrator (which checks our exit code) sees it
  if (!jobSucceeded) {
    process.exit(1);
  }
}
