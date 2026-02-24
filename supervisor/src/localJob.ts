import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { config } from "./config.js";
import { Job } from "./types.js";
import { createLogContext, finalizeLog } from "./logger.js";
import { minimatch } from "minimatch";

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

  // 3. Prepare directories (done first so containerName is available for the header)
  const { name: containerName, outputLogPath, debugLogPath } = createLogContext("oa-runner");

  // Tell the DTU which log directory to write step output into — do this as early as
  // possible so it's ready before the runner container boots and sends feed lines.
  const dtuUrl = config.GITHUB_API_URL;
  const stepOutputPath = path.join(path.dirname(outputLogPath), "step-output.log");
  await fetch(`${dtuUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runnerName: containerName, logDir: path.dirname(outputLogPath) }),
  }).catch(() => {
    /* non-fatal */
  });

  // Write metadata if available (to help the UI map logs to workflows)
  if (job.workflowPath) {
    const metadataPath = path.join(path.dirname(outputLogPath), "metadata.json");
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        { workflowPath: job.workflowPath, workflowName: path.basename(job.workflowPath) },
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
  const workspaceDir = path.resolve(process.cwd(), "_/work", `workspace-${workspaceId}`);
  const containerWorkDir = path.resolve(process.cwd(), "_/work", containerName);
  const shimsDir = path.resolve(process.cwd(), "_/shims", containerName);
  const diagDir = path.resolve(process.cwd(), "_/diag", containerName);

  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(containerWorkDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(shimsDir, { recursive: true, mode: 0o777 });
  fs.mkdirSync(diagDir, { recursive: true, mode: 0o777 });
  // Ensure all intermediate dirs are world-writable for DinD scenarios where
  // the supervisor runs as root but nested containers use runner user (UID 1001)
  try {
    fs.chmodSync(workspaceDir, 0o777);
    fs.chmodSync(containerWorkDir, 0o777);
    fs.chmodSync(shimsDir, 0o777);
    fs.chmodSync(diagDir, 0o777);
  } catch {
    // Ignore chmod errors (non-critical)
  }

  // 1. Seed the job to Local DTU
  const seedResponse = await fetch(`${dtuUrl}/_dtu/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: job.githubJobId || "1",
      name: "local-job",
      status: "queued",
      localPath: workspaceDir,
      ...job,
    }),
  });
  if (!seedResponse.ok) {
    throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
  }

  // 2. Registration token (mock for local)
  const registrationToken = "mock_local_token";

  // 4. Prepare workspace (checkout emulation)
  try {
    if (job.headSha && job.headSha !== "HEAD") {
      // Specific SHA requested — use git archive (clean snapshot)
      execSync(`git archive ${job.headSha} | tar -x -C ${workspaceDir}`, { stdio: "pipe" });
    } else {
      // Default: copy the working directory as-is, including dirty/untracked files.
      // rsync excludes .git to keep the workspace clean for the runner.
      const repoRoot = execSync(`git rev-parse --show-toplevel`).toString().trim();
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

    // Add fake git repo so actions/checkout uses fast-path (no delete+reclone)
    // The remote URL must exactly match what actions/checkout computes via URL.origin.
    // Node.js URL.origin strips the default port (80), so we must NOT include :80.
    // Use -b main so the default branch is 'main', matching what actions/checkout expects.
    execSync(`git init -b main`, { cwd: workspaceDir });
    execSync(`git config user.name "oa"`, { cwd: workspaceDir });
    execSync(`git config user.email "oa@example.com"`, { cwd: workspaceDir });
    execSync(`git remote add origin http://127.0.0.1/${config.GITHUB_REPO}`, {
      cwd: workspaceDir,
    });
    execSync(`git add . && git commit -m "Initial dummy commit" || true`, { cwd: workspaceDir });
  } catch (err) {
    if (debug) {
      console.warn(`[LocalJob] Failed to prepare workspace: ${err}. Using host fallback.`);
    }
  }

  // 5. Git shim
  // The workspace SHA must match what ls-remote returns so actions/checkout skips re-cloning.
  // Read the SHA from the workspace git repo (created just above), not from the host repo.
  let workspaceSha: string;
  try {
    workspaceSha = execSync(`git rev-parse HEAD`, { cwd: workspaceDir }).toString().trim();
  } catch {
    workspaceSha = "0000000000000000000000000000000000000000";
  }

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
  echo "http://127.0.0.1/\${GITHUB_REPOSITORY}"
  exit 0
fi

# actions/checkout probes ls-remote to find the target SHA.
# Return the workspace's own commit SHA so checkout thinks the workspace is current.
if [[ "$*" == *"ls-remote"* ]]; then
  echo "${workspaceSha}\tHEAD"
  echo "${workspaceSha}\trefs/heads/main"
  exit 0
fi

# Intercept fetch - we don't have a real git server, so fetch is a no-op.
# After fetch, actions/checkout will try: git checkout -B main refs/remotes/origin/main
# which fails because fetch returned nothing. We intercept that too, and redirect
# it to the local 'main' branch (which was created by the workspace git init).
if [[ "$*" == *"fetch"* ]]; then
  echo "[OA Shim] Intercepted 'fetch' - workspace is pre-populated."
  exit 0
fi

# Redirect: git checkout ... refs/remotes/origin/main -> create local main from HEAD.
# Note: actions/checkout deletes the local 'main' branch before fetching, so we cannot
# checkout the local branch - instead we recreate it from the current HEAD commit.
if [[ "$*" == *"checkout"* && "$*" == *"refs/remotes/origin/"* ]]; then
  echo "[OA Shim] Redirecting remote checkout - recreating main from HEAD."
  /usr/bin/git checkout -B main HEAD
  exit $?
fi

# Intercept clean and rm which can destroy workspace files
if [[ "$1" == "clean" || "$1" == "rm" ]]; then
  echo "[OA Shim] Intercepted '$1' to protect local files."
  exit 0
fi

# Pass through all other git commands (checkout, reset, log, init, config, etc.)
echo "git $@ (pass-through)" >> /home/runner/_diag/oa-git-calls.log
/usr/bin/git "$@"
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
  const repoUrl = `${dockerApiUrl}/${config.GITHUB_REPO}`;

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

  const container = await docker.createContainer({
    Image: IMAGE,
    name: containerName,
    Env: [
      `RUNNER_NAME=${containerName}`,
      `RUNNER_TOKEN=${registrationToken}`,
      `RUNNER_REPOSITORY_URL=${repoUrl}`,
      `GITHUB_API_URL=${dockerApiUrl}`,
      `GITHUB_SERVER_URL=${repoUrl}`,
      `GITHUB_REPOSITORY=${config.GITHUB_REPO}`,
      `OA_LOCAL_SYNC=true`,
      `OA_HEAD_SHA=${job.headSha || "HEAD"}`,
      `OA_DTU_HOST=${dtuHost}`,
      `ACTIONS_CACHE_URL=${dockerApiUrl}`,
      `ACTIONS_RUNTIME_TOKEN=mock_cache_token_123`,
      `PATH=/tmp/oa-shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    ],
    Cmd: [
      "bash",
      "-c",
      `export DEBIAN_FRONTEND=noninteractive && sudo -n chmod -R 777 /home/runner/_work /home/runner/_diag 2>/dev/null || true && sudo -n apt-get update >/dev/null 2>&1 && sudo -n apt-get install -y nginx >/dev/null 2>&1 && echo "server { listen 80 default_server; location / { proxy_pass http://$OA_DTU_HOST:${dtuPort}; proxy_set_header Host 127.0.0.1:80; } }" | sudo tee /etc/nginx/sites-available/default > /dev/null && sudo ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default && (sudo service nginx start >/dev/null 2>&1 || sudo nginx >/dev/null 2>&1) && sudo chmod 666 /var/run/docker.sock 2>/dev/null || true && RESOLVED_URL="http://127.0.0.1:80/$GITHUB_REPOSITORY" && export GITHUB_API_URL="http://127.0.0.1:80" && export GITHUB_SERVER_URL="$RESOLVED_URL" && ./config.sh --url "$RESOLVED_URL" --token "$RUNNER_TOKEN" --name "$RUNNER_NAME" --unattended --ephemeral --work _work --labels opposite-actions || echo "Config warning: Service generation failed, proceeding..." && REPO_NAME=$(basename $GITHUB_REPOSITORY) && WORKSPACE_PATH=/home/runner/_work/$REPO_NAME/$REPO_NAME && mkdir -p $WORKSPACE_PATH && (cp -a /tmp/oa-workspace/. $WORKSPACE_PATH/ 2>/dev/null && echo "Workspace ready: $(ls $WORKSPACE_PATH | wc -l) files" || echo "Workspace copy skipped - no mounted workspace") && ./run.sh --once`,
    ],
    HostConfig: {
      Binds: [
        `${path.resolve(process.cwd(), "_/work", containerName)}:/home/runner/_work`,
        "/var/run/docker.sock:/var/run/docker.sock",
        `${shimsDir}:/tmp/oa-shims`,
        `${diagDir}:/home/runner/_diag`,
        `${workspaceDir}:/tmp/oa-workspace`,
      ],
      AutoRemove: false,
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
  if (fs.existsSync(workspaceDir)) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (fs.existsSync(shimsDir)) {
    fs.rmSync(shimsDir, { recursive: true, force: true });
  }
  if (fs.existsSync(diagDir)) {
    fs.rmSync(diagDir, { recursive: true, force: true });
  }
}
