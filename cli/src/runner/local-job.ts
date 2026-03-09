import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { config } from "../config.js";
import { Job } from "../types.js";
import { createLogContext } from "../output/logger.js";
import { getWorkingDirectory } from "../output/working-directory.js";

import { debugRunner } from "../output/debug.js";
import {
  startServiceContainers,
  cleanupServiceContainers,
  type ServiceContext,
} from "../docker/service-containers.js";
import { killRunnerContainers } from "../docker/shutdown.js";
import { startEphemeralDtu } from "dtu-github-actions/ephemeral";
import { type JobResult, tailLogFile } from "../output/reporter.js";
import logUpdate from "log-update";
import { renderTree, type TreeNode } from "../output/tree-renderer.js";

import { writeJobMetadata } from "./metadata.js";
import { computeFakeSha, writeGitShim } from "./git-shim.js";
import { prepareWorkspace } from "./workspace.js";
import { createRunDirectories } from "./directory-setup.js";
import {
  buildContainerEnv,
  buildContainerBinds,
  buildContainerCmd,
  resolveDtuHost,
  resolveDockerApiUrl,
} from "../docker/container-config.js";
import { buildJobResult, sanitizeStepName } from "./result-builder.js";
import { wrapJobSteps } from "./step-wrapper.js";
import { syncWorkspaceForRetry } from "./sync.js";

// ─── Docker setup ─────────────────────────────────────────────────────────────

const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
const dockerConfig = dockerHost.startsWith("unix://")
  ? { socketPath: dockerHost.replace("unix://", "") }
  : { host: dockerHost, protocol: "ssh" as const };

const docker = new Docker(dockerConfig);

const IMAGE = "ghcr.io/actions/actions-runner:latest";

// ─── Pre-baked runner credentials ─────────────────────────────────────────────
// The GitHub Actions runner normally requires `config.sh` (a .NET binary) to
// generate .runner, .credentials and .credentials_rsaparams before run.sh can
// start.  Each invocation cold-starts .NET 6, costing ~3-5s — and we were
// running it twice (remove + register).
//
// Since the DTU mock accepts any credential values, we write these files
// directly with deterministic content, saving ~5-10s per container start.

function writeRunnerCredentials(runnerDir: string, runnerName: string, serverUrl: string): void {
  // .runner — tells run.sh who it is and where to connect
  const dotRunner = {
    agentId: 1,
    agentName: runnerName,
    poolId: 1,
    poolName: "Default",
    serverUrl: "http://127.0.0.1:80",
    gitHubUrl: serverUrl,
    workFolder: "_work",
    ephemeral: true,
  };
  fs.writeFileSync(path.join(runnerDir, ".runner"), JSON.stringify(dotRunner, null, 2));

  // .credentials — OAuth scheme that run.sh reads to authenticate with the DTU
  const dotCredentials = {
    scheme: "OAuth",
    data: {
      clientId: "00000000-0000-0000-0000-000000000000",
      authorizationUrl: `${serverUrl}/_apis/oauth2/token`,
      oAuthEndpointUrl: `${serverUrl}/_apis/oauth2/token`,
      requireFipsCryptography: "False",
    },
  };
  fs.writeFileSync(path.join(runnerDir, ".credentials"), JSON.stringify(dotCredentials, null, 2));

  // .credentials_rsaparams — RSA key the runner uses for token signing.
  // Format: RSAParametersSerializable JSON (ISerializable with lowercase keys
  // matching the RSAParametersSerializable constructor). The DTU mock never
  // validates signatures, so we use a static pre-generated RSA 2048-bit key.
  const dotRsaParams = {
    d: "CQpCI+sO2GD1N/JsHHI9zEhMlu5Fcc8mU4O2bO6iscOsagFjvEnTesJgydC/Go1HuOBlx+GT9EG2h7+juS0z2o5n8Mvt5BBxlK+tqoDOs8VfQ9CSUl3hqYRPeNdBfnA1w8ovLW0wqfPO08FWTLI0urYsnwjZ5BQrBM+D7zYeA0aCsKdo75bKmaEKnmqrtIEhb7hE45XQa32Yt0RPCPi8QcQAY2HLHbdWdZYDj6k/UuDvz9H/xlDzwYq6Yikk2RSMArFzaufxCGS9tBZNEACDPYgnZnEMXRcvsnZ9FYbq81KOSifCmq7Yocq+j3rY5zJCD+PIDY9QJwPxB4PGasRKAQ==",
    dp: "A0sY1oOz1+3uUMiy+I5xGuHGHOrEQPYspd1xGClBYYsa/Za0UDWS7V0Tn1cbRWfWtNe5vTpxcvwQd6UZBwrtHF6R2zyXFhE++PLPhCe0tH4C5FY9i9jUw9Vo8t44i/s5JUHU2B1mEptXFUA0GcVrLKS8toZSgqELSS2Q/YLRxoE=",
    dq: "GrLC9dPJ5n3VYw51ghCH7tybUN9/Oe4T8d9v4dLQ34RQEWHwRd4g3U3zkvuhpXFPloUTMmkxS7MF5pS1evrtzkay4QUTDv+28s0xRuAsw5qNTzuFygg8t93MvpvTVZ2TNApW6C7NFvkL9NbxAnU8+I61/3ow7i6a7oYJJ0hWAxE=",
    exponent: "AQAB",
    inverseQ:
      "8DVz9FSvEdt5W4B9OjgakZHwGfnhn2VLDUxrsR5ilC5tPC/IgA8C2xEfKQM1t+K/N3pAYHBYQ6EPgtW4kquBS/Sy102xbRI7GSCnUbRtTpWYPOaCn6EaxBNzwWzbp5vCbCGvFqlSu4+OBYRVe+iCj+gAnkmT/TKPhHHbTjJHvw==",
    modulus:
      "x0eoW2DD7xsW5YiorMN8pNHVvZk4ED1SHlA/bmVnRz5FjEDnQloMn0nBgIUHxoNArksknrp/FOVJv5sJHJTiRZkOp+ZmH7d3W3gmw63IxK2C5pV+6xfav9jR2+Wt/6FMYMgG2utBdF95oif1f2XREFovHoXkWms2l0CPLLHVPO44Hh9EEmBmjOeMJEZkulHJ44z9y8e+GZ2nYqO0ZiRWQcRObZ0vlRaGg6PPOl4ltay0BfNksMB3NDtlhkdVkAEFQxEaZZDK9NtkvNljXCioP3TyTAbqNUGsYCA5D+IHGZT9An99J9vUqTFP6TKjqUvy9WNiIzaUksCySA0a4SVBkQ==",
    p: "8fgAdmWy+sTzAN19fYkWMQqeC7t1BCQMo5z5knfVLg8TtwP9ZGqDtoe+r0bGv3UgVsvvDdP/QwRvRVP+5G9l999Y6b4VbSdUbrfPfOgjpPDmRTQzHDve5jh5xBENQoRXYm7PMgHGmjwuFsE/tKtSGTrvt2Z3qcYAo0IOqLLhYmE=",
    q: "0tXx4+P7gUWePf92UJLkzhNBClvdnmDbIt52Lui7YCARczbN/asCDJxcMy6Bh3qmIx/bNuOUrfzHkYZHfnRw8AGEK80qmiLLPI6jrUBOGRajmzemGQx0W8FWalEQfGdNIv9R2nsegDRoMq255Zo/qX60xQ6abpp0c6UNhVYSjTE=",
  };
  fs.writeFileSync(path.join(runnerDir, ".credentials_rsaparams"), JSON.stringify(dotRsaParams));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function executeLocalJob(
  job: Job,
  options?: { pauseOnFailure?: boolean },
): Promise<JobResult> {
  const pauseOnFailure = options?.pauseOnFailure ?? true;
  const startTime = Date.now();

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
    debugLogPath,
  } = createLogContext("machinen", job.runnerName);

  // Start an ephemeral in-process DTU for this job run so each job gets its
  // own isolated DTU instance on a random port — eliminating port conflicts.
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  const ephemeralDtu = await startEphemeralDtu(dtuCacheDir).catch(() => null);
  const dtuUrl = ephemeralDtu?.url ?? config.GITHUB_API_URL;

  await fetch(`${dtuUrl}/_dtu/start-runner`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runnerName: containerName,
      logDir,
      timelineDir: logDir,
      // Package manager stores are bind-mounted into the container, so there's
      // no need for the runner to tar/gzip them. Tell the DTU to return a
      // synthetic hit for any cache key matching these patterns — skipping the
      // 60s+ tar entirely.
      virtualCachePatterns: ["pnpm", "npm", "yarn", "bun"],
    }),
  }).catch(() => {
    /* non-fatal */
  });

  // Write metadata if available (to help the UI map logs to workflows)
  writeJobMetadata({ logDir, containerName, job });

  // Open debug stream to capture raw container output
  const debugStream = fs.createWriteStream(debugLogPath);
  /** Write a line to stdout. */
  const emit = (line: string) => {
    process.stdout.write(line + "\n");
  };

  // ── Preflight boot tracker ───────────────────────────────────────────────
  // Shows a spinner with elapsed time while the container boots up.
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIdx = 0;
  const bootStart = Date.now();
  const workflowBasename = job.workflowPath ? path.basename(job.workflowPath) : "workflow";

  const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

  const renderBootTree = () => {
    const elapsed = Math.round((Date.now() - bootStart) / 1000);
    const frame = spinnerFrames[spinnerIdx++ % spinnerFrames.length];
    const tree: TreeNode[] = [
      {
        label: workflowBasename,
        children: [{ label: `${frame} Starting runner ${containerName} (${elapsed}s)` }],
      },
    ];
    logUpdate(renderTree(tree));
  };

  let spinnerInterval: ReturnType<typeof setInterval> | null = setInterval(renderBootTree, 80);
  let bootDurationMs = 0;

  // ── Create run directories ────────────────────────────────────────────────
  const dirs = createRunDirectories({
    runDir,
    githubRepo: job.githubRepo,
    workflowPath: job.workflowPath,
  });

  // Signal handler: ensure cleanup runs even when killed.
  // Kills the Docker container + any service sidecars + network, then removes temp dirs.
  // Use process.once so multiple calls to executeLocalJob() don't accumulate listeners.
  const signalCleanup = () => {
    // Force-kill Docker containers (sync so it works in signal handlers)
    killRunnerContainers(containerName);
    for (const d of [dirs.containerWorkDir, dirs.shimsDir, dirs.signalsDir, dirs.diagDir]) {
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
    // workspace paths, rather than the webhook event repo that may point to a different name.
    const [githubOwner, githubRepoName] = (job.githubRepo || "").split("/");
    const overriddenRepository = job.githubRepo
      ? {
          full_name: job.githubRepo,
          name: githubRepoName,
          owner: { login: githubOwner },
          default_branch: job.repository?.default_branch || "main",
        }
      : job.repository;

    // Wrap run: steps in the pause-on-failure retry loop before seeding
    const seededSteps = pauseOnFailure ? wrapJobSteps(job.steps ?? [], true) : job.steps;

    const seedResponse = await fetch(`${dtuUrl}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        localPath: dirs.workspaceDir,
        ...job,
        steps: seededSteps,
        // Override repository with the git-remote-resolved repo (takes precedence over ...job spread)
        repository: overriddenRepository,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }

    // 2. Registration token (mock for local)
    const registrationToken = "mock_local_token";

    // 4. Prepare workspace + git shim — kicked off now, awaited after container.start().
    // These can run in parallel with container setup because the workspace directory
    // already exists and the container entrypoint takes ~1-2s before touching files.
    const workspacePrepPromise = (async () => {
      try {
        prepareWorkspace({
          workflowPath: job.workflowPath,
          headSha: job.headSha,
          githubRepo: job.githubRepo,
          workspaceDir: dirs.workspaceDir,
        });
      } catch (err) {
        debugRunner(`Failed to prepare workspace: ${err}. Using host fallback.`);
      }
      const fakeSha = computeFakeSha(job.headSha);
      writeGitShim(dirs.shimsDir, fakeSha);

      // Set permissions on the host so the entrypoint doesn't need recursive chmod.
      // The runner user (UID 1001) inside the container must be able to read/write
      // workspace and diag files via bind-mount.
      try {
        execSync(`chmod -R 777 "${dirs.containerWorkDir}" "${dirs.diagDir}"`, { stdio: "pipe" });
      } catch {
        // Non-fatal: entrypoint has a fallback
      }
    })();

    // 6. Spawn container
    const dtuPort = new URL(dtuUrl).port || "80";
    const dtuHost = resolveDtuHost();
    const dockerApiUrl = resolveDockerApiUrl(dtuUrl, dtuHost);
    const githubRepo = job.githubRepo || config.GITHUB_REPO;
    const repoUrl = `${dockerApiUrl}/${githubRepo}`;

    debugRunner(`Spawning container ${containerName}...`);

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
    const hostWorkDir = dirs.containerWorkDir;
    // Shared seed directory — extracted once and reused across all containers.
    const hostRunnerSeedDir = path.resolve(getWorkingDirectory(), "runner");
    // Per-container copy — each container gets its own writable copy so concurrent
    // config.sh / run.sh invocations don't race on .runner / .credentials files.
    const hostRunnerDir = path.resolve(runDir, "runner");
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
        const tmpName = `machinen-seed-runner-${Date.now()}`;
        const seedContainer = await docker.createContainer({
          Image: IMAGE,
          name: tmpName,
          Cmd: ["true"],
        });
        const { execSync } = await import("node:child_process");
        execSync(`docker cp ${tmpName}:/home/runner/. "${hostRunnerSeedDir}/"`, { stdio: "pipe" });
        await seedContainer.remove();
        // Patch config.sh to skip the dependency checks (ldd/ldconfig for libicu etc.)
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
      // Clean stale runner auth files from the seed dir itself
      for (const staleFile of [".runner", ".credentials", ".credentials_rsaparams"]) {
        try {
          fs.rmSync(path.join(hostRunnerSeedDir, staleFile));
        } catch {
          /* not present */
        }
      }
      // Copy seed to per-container directory so run.sh invocations don't race.
      execSync(`cp -a "${hostRunnerSeedDir}" "${hostRunnerDir}"`, { stdio: "pipe" });

      // ── Pre-bake runner credentials ──────────────────────────────────────────
      // Instead of running config.sh (which cold-starts .NET, ~5-10s), we write
      // the credential files directly. The DTU mock accepts any values, so we
      // use deterministic static content stamped with this container's identity.
      const resolvedUrl = `http://127.0.0.1:80/${githubRepo}`;
      writeRunnerCredentials(hostRunnerDir, containerName, resolvedUrl);
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

    const containerEnv = buildContainerEnv({
      containerName,
      registrationToken,
      repoUrl,
      dockerApiUrl,
      githubRepo,
      headSha: job.headSha,
      dtuHost,
      useDirectContainer,
    });

    const containerBinds = buildContainerBinds({
      hostWorkDir,
      shimsDir: dirs.shimsDir,
      signalsDir: pauseOnFailure ? dirs.signalsDir : undefined,
      diagDir: dirs.diagDir,
      toolCacheDir: dirs.toolCacheDir,
      pnpmStoreDir: dirs.pnpmStoreDir,
      npmCacheDir: dirs.npmCacheDir,
      bunCacheDir: dirs.bunCacheDir,
      playwrightCacheDir: dirs.playwrightCacheDir,
      warmModulesDir: dirs.warmModulesDir,
      hostRunnerDir,
      useDirectContainer,
    });

    const containerCmd = buildContainerCmd({
      svcPortForwardSnippet,
      dtuPort,
      useDirectContainer,
      containerName,
    });

    const container = await docker.createContainer({
      Image: containerImage,
      name: containerName,
      Env: containerEnv,
      ...(useDirectContainer ? { Entrypoint: ["bash"] } : {}),
      Cmd: containerCmd,
      HostConfig: {
        Binds: containerBinds,
        AutoRemove: false,
        Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }],
        ...(serviceCtx ? { NetworkMode: serviceCtx.networkName } : {}),
      },
      Tty: true,
    });

    // Start the container and ensure workspace prep has finished in parallel.
    await Promise.all([container.start(), workspacePrepPromise]);

    // 7. Stream logs ─────────────────────────────────────────────────────────────
    // Use readline so we process complete lines (no split ANSI sequences).
    // Write ALL lines to debug.log; write filtered lines to output.log and stdout.
    const rawStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    // The boot spinner keeps running until the first timeline entry appears.
    // This captures the full startup time including .NET cold-start inside
    // the container.

    // ANSI color helpers
    const YELLOW = `${String.fromCharCode(27)}[33m`;
    const RESET = `${String.fromCharCode(27)}[0m`;

    let tailDone = false;
    let lastFailedStep: string | null = null;
    let isPaused = false;
    let pausedStepName: string | null = null;
    let pausedAtMs: number | null = null;
    let lastSeenAttempt = 0;
    let stdinListening = false;
    const timelinePath = path.join(logDir, "timeline.json");
    const pausedSignalPath = path.join(dirs.signalsDir, "paused");
    const signalsRunDir = path.dirname(dirs.signalsDir);

    // Listen for Enter key to trigger retry when paused
    const setupStdinRetry = () => {
      if (stdinListening || !process.stdin.isTTY) {
        return;
      }
      stdinListening = true;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", (key: Buffer) => {
        // Ctrl+C
        if (key[0] === 3) {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
        // Enter
        if (key[0] === 13 && isPaused) {
          syncWorkspaceForRetry(signalsRunDir);
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

    const checkTimeline = () => {
      try {
        // ── Pause-on-failure: check for paused signal ───────────────────────────
        if (pauseOnFailure && fs.existsSync(pausedSignalPath)) {
          const content = fs.readFileSync(pausedSignalPath, "utf-8").trim();
          const lines = content.split("\n");
          pausedStepName = lines[0] || null;
          const attempt = parseInt(lines[1] || "1", 10);
          if (attempt !== lastSeenAttempt) {
            lastSeenAttempt = attempt;
            isPaused = true;
            pausedAtMs = Date.now();
            setupStdinRetry();
          }
        } else if (isPaused && !fs.existsSync(pausedSignalPath)) {
          // File completely gone (abort cleaned it up)
          isPaused = false;
          pausedAtMs = null;
        }
        if (!fs.existsSync(timelinePath)) {
          return;
        }
        const records: any[] = JSON.parse(fs.readFileSync(timelinePath, "utf-8"));
        const steps = records
          .filter((r) => r.type === "Task" && r.name)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        if (steps.length === 0) {
          return;
        }

        // ── Finalize boot spinner on first timeline entry ──────────────────────
        if (spinnerInterval) {
          clearInterval(spinnerInterval);
          spinnerInterval = null;
          bootDurationMs = Date.now() - bootStart;
        }

        // Build step child nodes for the tree
        const stepNodes: TreeNode[] = [];
        const seenNames = new Set<string>();
        let hasPostSteps = false;
        let stepIdx = 0;
        let completeJobRecord: any = null;

        // Pre-compute total step count for left-padding numbers.
        // "Complete job" is excluded because it is always rendered last
        // (after "Post Setup" when present) and gets its number at the end.
        const preCountNames = new Set<string>();
        for (const r of steps) {
          if (!preCountNames.has(r.name)) {
            preCountNames.add(r.name);
          } else {
            hasPostSteps = true;
          }
        }
        // Total = unique names (minus "Complete job" which is re‑added at end)
        //       + "Post Setup" (if present)
        //       + "Complete job" (always last)
        const hasCompleteJob = preCountNames.has("Complete job");
        const totalSteps =
          preCountNames.size -
          (hasCompleteJob ? 1 : 0) +
          (hasPostSteps ? 1 : 0) +
          (hasCompleteJob ? 1 : 0);
        const padW = String(totalSteps).length;
        const pad = (n: number) => String(n).padStart(padW);

        for (const r of steps) {
          // Post-job cleanup steps share the same name as an earlier step — skip them.
          if (seenNames.has(r.name)) {
            continue;
          }
          seenNames.add(r.name);

          // "Complete job" is always rendered last — capture it and skip here.
          if (r.name === "Complete job") {
            completeJobRecord = r;
            continue;
          }
          stepIdx++;

          let dur = "";
          if (r.startTime && r.finishTime) {
            const ms = new Date(r.finishTime).getTime() - new Date(r.startTime).getTime();
            if (!isNaN(ms) && ms >= 0) {
              dur = ` (${Math.round(ms / 1000)}s)`;
            }
          }

          const stepName = r.name as string;

          // Step hasn't completed yet
          if (!r.result && r.state !== "completed") {
            if (r.startTime) {
              const stepElapsed = Math.round((Date.now() - new Date(r.startTime).getTime()) / 1000);
              const frame = spinnerFrames[spinnerIdx % spinnerFrames.length];
              if (isPaused && pausedStepName === stepName) {
                // Paused: show ⏸ icon with frozen timer
                const frozenElapsed = pausedAtMs
                  ? Math.round((pausedAtMs - new Date(r.startTime).getTime()) / 1000)
                  : stepElapsed;
                stepNodes.push({
                  label: `⏸ ${pad(stepIdx)}. ${stepName} (${frozenElapsed}s)`,
                  children: [{ label: `${YELLOW}Step failed attempt #${lastSeenAttempt}${RESET}` }],
                });
              } else if (!isPaused && lastSeenAttempt > 0 && pausedStepName === stepName) {
                stepNodes.push({
                  label: `${frame} ${pad(stepIdx)}. ${stepName} — retrying (${stepElapsed}s...)`,
                });
              } else {
                stepNodes.push({
                  label: `${frame} ${pad(stepIdx)}. ${stepName} (${stepElapsed}s...)`,
                });
              }
            } else {
              stepNodes.push({ label: `○ ${pad(stepIdx)}. ${stepName}` });
            }
            continue;
          }

          // Step completed
          const result = (r.result || "").toLowerCase();
          if (result === "failed") {
            lastFailedStep = r.name;
            stepNodes.push({ label: `✗ ${pad(stepIdx)}. ${stepName}${dur}` });
          } else if (result === "skipped") {
            stepNodes.push({ label: `⊘ ${pad(stepIdx)}. ${stepName}${dur}` });
          } else {
            stepNodes.push({ label: `✓ ${pad(stepIdx)}. ${stepName}${dur}` });
          }
        }

        // "Post Setup" and "Complete job" only appear once the job has actually finished
        const jobFinished = completeJobRecord?.result;
        if (hasPostSteps && jobFinished) {
          stepIdx++;
          stepNodes.push({ label: `✓ ${pad(stepIdx)}. Post Setup` });
        }
        if (completeJobRecord && jobFinished) {
          stepIdx++;
          let dur = "";
          if (completeJobRecord.startTime && completeJobRecord.finishTime) {
            const ms =
              new Date(completeJobRecord.finishTime).getTime() -
              new Date(completeJobRecord.startTime).getTime();
            if (!isNaN(ms) && ms >= 0) {
              dur = ` (${Math.round(ms / 1000)}s)`;
            }
          }
          stepNodes.push({ label: `✓ ${pad(stepIdx)}. Complete job${dur}` });
        }

        // Build the full tree: workflow → Starting runner + job → steps
        const startingNode: TreeNode = {
          label: spinnerInterval
            ? `${spinnerFrames[spinnerIdx % spinnerFrames.length]} Starting runner ${containerName}`
            : `Starting runner ${containerName} (${fmtMs(bootDurationMs)})`,
        };
        const tree: TreeNode[] = [
          {
            label: workflowBasename,
            children: [
              startingNode,
              {
                label: `${job.taskId ?? "job"}`,
                children: stepNodes,
              },
            ],
          },
        ];

        let output = renderTree(tree);
        // Append failure output below the tree when paused
        if (isPaused && pausedStepName) {
          // Read step log and show last output lines below the tree.
          // The sanitized step name may not match the log filename (the DTU
          // writes logs under a feed-record UUID). Fall back to the newest .log.
          const DIM = `${String.fromCharCode(27)}[2m`;
          const stepsDir = path.join(logDir, "steps");
          let tailLines: string[] = [];
          const sanitized = sanitizeStepName(pausedStepName);
          const byName = path.join(stepsDir, `${sanitized}.log`);
          tailLines = tailLogFile(byName, 20);
          if (tailLines.length === 0 && fs.existsSync(stepsDir)) {
            let newest = "";
            let newestMtime = 0;
            for (const f of fs.readdirSync(stepsDir)) {
              if (!f.endsWith(".log")) {
                continue;
              }
              const mt = fs.statSync(path.join(stepsDir, f)).mtimeMs;
              if (mt > newestMtime) {
                newestMtime = mt;
                newest = f;
              }
            }
            if (newest) {
              tailLines = tailLogFile(path.join(stepsDir, newest), 20);
            }
          }
          if (tailLines.length > 0) {
            output += `\n\n  ${DIM}Last output:${RESET}`;
            for (const line of tailLines) {
              const trimmed = line.trimEnd();
              if (trimmed) {
                output += `\n    ${DIM}${trimmed}${RESET}`;
              }
            }
          }
          output += `\n\n  ${YELLOW}↻ To retry:  machinen retry --runner ${containerName} [enter]${RESET}`;
          output += `\n  ${YELLOW}■ To abort:  machinen abort --runner ${containerName}${RESET}`;
        }

        logUpdate(output);
      } catch {
        // Best-effort
      }
    };

    const pollPromise = (async () => {
      while (!tailDone) {
        spinnerIdx++;
        checkTimeline();
        await new Promise((r) => setTimeout(r, 100));
      }
      // Final check
      checkTimeline();
      // Ensure the final state is written to stdout permanently
      logUpdate.done();
    })();

    // Start waiting for container exit in parallel with log streaming.
    const containerWaitPromise = container.wait();

    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: rawStream, crlfDelay: Infinity });

      rl.on("line", (line) => {
        debugStream.write(line + "\n");
      });

      rl.on("close", () => {
        resolve();
      });

      // When the container exits, destroy the raw stream so readline closes promptly.
      containerWaitPromise
        .then(() => {
          (rawStream as any).destroy?.();
        })
        .catch(() => {});
    });

    // Stop tail now that container has finished
    tailDone = true;
    cleanupStdin();
    await pollPromise;

    // 8. Wait for completion (already started above; just collect the result)
    const CONTAINER_EXIT_TIMEOUT_MS = 30_000;
    let waitResult: { StatusCode: number };
    try {
      waitResult = await Promise.race([
        containerWaitPromise,
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

    // Derive job result from timeline: if any step failed, the job failed.
    // Fall back to container exit code if timeline is unavailable.
    const jobSucceeded = lastFailedStep === null && containerExitCode === 0;

    // Close debug stream now that all lines are written
    await new Promise<void>((resolve) => debugStream.end(resolve));

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
    if (fs.existsSync(dirs.shimsDir)) {
      fs.rmSync(dirs.shimsDir, { recursive: true, force: true });
    }
    // Keep the signals dir alive when pauseOnFailure is set so the external
    // retry/abort command can find it. Otherwise clean it up.
    if (!pauseOnFailure && fs.existsSync(dirs.signalsDir)) {
      fs.rmSync(dirs.signalsDir, { recursive: true, force: true });
    }
    if (fs.existsSync(dirs.diagDir)) {
      fs.rmSync(dirs.diagDir, { recursive: true, force: true });
    }
    // Clean per-container runner copy (always safe to remove)
    if (fs.existsSync(hostRunnerDir)) {
      fs.rmSync(hostRunnerDir, { recursive: true, force: true });
    }
    // Clean containerWorkDir only on success (keep failed workspaces for inspection)
    if (jobSucceeded && fs.existsSync(dirs.containerWorkDir)) {
      fs.rmSync(dirs.containerWorkDir, { recursive: true, force: true });
    }

    await ephemeralDtu?.close().catch(() => {});

    // Build structured result for the caller
    return buildJobResult({
      containerName,
      job,
      startTime,
      jobSucceeded,
      lastFailedStep,
      containerExitCode,
      timelinePath,
      logDir,
      debugLogPath,
    });
  } finally {
    // Always stop the preflight spinner if it's still running (e.g. error during setup)
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      logUpdate.clear();
    }
    // Always deregister signal handlers, even if an error was thrown before the
    // normal completion path (e.g. seed failure, container start failure).
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
  }
}
