import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { config } from "../config.js";
import { Job } from "../types.js";
import { createLogContext } from "../output/logger.js";
import { getWorkingDirectory } from "../output/working-directory.js";

import { debugRunner, debugBoot } from "../output/debug.js";
import {
  startServiceContainers,
  cleanupServiceContainers,
  type ServiceContext,
} from "../docker/service-containers.js";
import { killRunnerContainers } from "../docker/shutdown.js";
import { startEphemeralDtu } from "dtu-github-actions/ephemeral";
import { type JobResult, tailLogFile } from "../output/reporter.js";
import { RunStateStore, type StepState } from "../output/run-state.js";

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
  resolveDockerExtraHosts,
} from "../docker/container-config.js";
import { buildJobResult } from "./result-builder.js";
import { wrapJobSteps, appendOutputCaptureStep } from "./step-wrapper.js";
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
    serverUrl: new URL(serverUrl).origin,
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
  options?: { pauseOnFailure?: boolean; store?: RunStateStore },
): Promise<JobResult> {
  const pauseOnFailure = options?.pauseOnFailure ?? false;
  const startTime = Date.now();
  const store = options?.store;

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

  // ── Prepare directories ───────────────────────────────────────────────────
  const {
    name: containerName,
    runDir,
    logDir,
    debugLogPath,
  } = createLogContext("agent-ci", job.runnerName);

  // Register the job in the store so the render loop can show the boot spinner
  store?.addJob(job.workflowPath ?? "", job.taskId ?? "job", containerName, {
    logDir,
    debugLogPath,
  });
  store?.updateJob(containerName, {
    status: "booting",
    startedAt: new Date().toISOString(),
  });

  const bootStart = Date.now();
  const bt = (label: string, since: number) => {
    debugBoot(`${containerName} ${label}: ${Date.now() - since}ms`);
    return Date.now();
  };

  // Start an ephemeral in-process DTU for this job run so each job gets its
  // own isolated DTU instance on a random port — eliminating port conflicts.
  let t0 = Date.now();
  const dtuCacheDir = path.resolve(getWorkingDirectory(), "cache", "dtu");
  let ephemeralDtu: Awaited<ReturnType<typeof startEphemeralDtu>> | null = null;
  try {
    ephemeralDtu = await startEphemeralDtu(dtuCacheDir);
    debugRunner(
      `DTU server started - CLI URL: ${ephemeralDtu.url}, Container URL: ${ephemeralDtu.containerUrl}`,
    );
  } catch (e) {
    debugRunner(`Failed to start ephemeral DTU: ${e}`);
  }
  // CLI uses url (127.0.0.1), containers use containerUrl (host IP)
  const dtuUrl = ephemeralDtu?.url ?? config.GITHUB_API_URL;
  const dtuContainerUrl = ephemeralDtu?.containerUrl ?? dtuUrl;
  t0 = bt("dtu-start", t0);

  // ── Create run directories ────────────────────────────────────────────────
  // Done before DTU registration so we can use the detected package manager
  // to scope virtualCachePatterns to only the relevant PM.
  const dirs = createRunDirectories({
    runDir,
    githubRepo: job.githubRepo,
    workflowPath: job.workflowPath,
  });
  debugRunner(`Detected package manager: ${dirs.detectedPM ?? "none (mounting all PM caches)"}`);

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
      virtualCachePatterns: dirs.detectedPM ? [dirs.detectedPM] : ["pnpm", "npm", "yarn", "bun"],
    }),
  }).catch(() => {
    /* non-fatal */
  });
  t0 = bt("dtu-register", t0);

  // Write metadata if available (to help the UI map logs to workflows)
  writeJobMetadata({ logDir, containerName, job });

  // Open debug stream to capture raw container output
  const debugStream = fs.createWriteStream(debugLogPath);

  // Signal handler: ensure cleanup runs even when killed.
  // Do NOT call process.exit() here — multiple jobs register handlers concurrently,
  // and an early exit would prevent other jobs' handlers from cleaning up their containers.
  // killRunnerContainers already handles the runner, its svc-* sidecars, and the network.
  const signalCleanup = () => {
    killRunnerContainers(containerName);
    for (const d of [dirs.containerWorkDir, dirs.shimsDir, dirs.signalsDir, dirs.diagDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
  };
  process.on("SIGINT", signalCleanup);
  process.on("SIGTERM", signalCleanup);

  // Hoisted for cleanup in `finally` — assigned inside the try block.
  let container: Docker.Container | null = null;
  let serviceCtx: ServiceContext | undefined;
  const hostRunnerDir = path.resolve(runDir, "runner");

  try {
    // 1. Seed the job to Local DTU
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

    // Pin runnerName so the job goes to the runner-specific pool, not the
    // shared generic pool where a runner from another concurrent workflow
    // could steal it (see issue #103).
    job.runnerName = containerName;

    t0 = Date.now();
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
        repository: overriddenRepository,
      }),
    });
    if (!seedResponse.ok) {
      throw new Error(`Failed to seed DTU: ${seedResponse.status} ${seedResponse.statusText}`);
    }
    t0 = bt("dtu-seed", t0);

    // 2. Registration token (mock for local)
    const registrationToken = "mock_local_token";

    // 4. Write git shim BEFORE container start so the entrypoint can install it
    // immediately. On Linux, prepareWorkspace (rsync) is slow enough that the
    // container entrypoint would race ahead and find an empty shims dir.
    const fakeSha = computeFakeSha(job.headSha);
    writeGitShim(dirs.shimsDir, fakeSha);

    // Prepare workspace files in parallel with container setup
    const workspacePrepStart = Date.now();
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

      try {
        execSync(`chmod -R 777 "${dirs.containerWorkDir}" "${dirs.diagDir}"`, { stdio: "pipe" });
      } catch {
        // Non-fatal: entrypoint has a fallback
      }
      bt("workspace-prep", workspacePrepStart);
    })();

    // 6. Spawn container
    const dtuHost = await resolveDtuHost();
    const dockerApiUrl = resolveDockerApiUrl(dtuContainerUrl, dtuHost);
    const parsedDockerApiUrl = new URL(dockerApiUrl);
    const dtuPort =
      parsedDockerApiUrl.port || (parsedDockerApiUrl.protocol === "https:" ? "443" : "80");
    const githubRepo = job.githubRepo || config.GITHUB_REPO;
    const repoUrl = `${dockerApiUrl}/${githubRepo}`;

    debugRunner(`Spawning container ${containerName}...`);
    debugRunner(`DTU config - Port: ${dtuPort}, Host: ${dtuHost}, Docker API: ${dockerApiUrl}`);
    debugRunner(`Runner will connect to: ${repoUrl}`);

    // Pre-cleanup: remove any stale container with the same name
    try {
      const stale = docker.getContainer(containerName);
      await stale.remove({ force: true });
    } catch {
      // Ignore - container doesn't exist
    }

    // ── Service containers ────────────────────────────────────────────────────
    if (job.services && job.services.length > 0) {
      const svcStart = Date.now();
      debugRunner(`Starting ${job.services.length} service container(s)...`);
      serviceCtx = await startServiceContainers(docker, job.services, containerName, (line) =>
        debugRunner(line),
      );
      bt("service-containers", svcStart);
    }

    const svcPortForwardSnippet = serviceCtx?.portForwards.length
      ? serviceCtx.portForwards.join(" \n") + " \nsleep 0.3 && "
      : "";

    // ── Direct container injection ─────────────────────────────────────────────
    const hostWorkDir = dirs.containerWorkDir;
    const hostRunnerSeedDir = path.resolve(getWorkingDirectory(), "runner");
    const useDirectContainer = !!job.container;
    const containerImage = useDirectContainer ? job.container!.image : IMAGE;

    if (useDirectContainer) {
      await fs.promises.mkdir(hostRunnerSeedDir, { recursive: true });
      const markerFile = path.join(hostRunnerSeedDir, ".seeded");
      try {
        await fs.promises.access(markerFile);
      } catch {
        debugRunner(`Extracting runner binary to host (one-time)...`);
        const tmpName = `agent-ci-seed-runner-${Date.now()}`;
        const seedContainer = await docker.createContainer({
          Image: IMAGE,
          name: tmpName,
          Cmd: ["true"],
        });
        const { execSync } = await import("node:child_process");
        execSync(`docker cp ${tmpName}:/home/runner/. "${hostRunnerSeedDir}/"`, { stdio: "pipe" });
        await seedContainer.remove();
        const configShPath = path.join(hostRunnerSeedDir, "config.sh");
        let configSh = await fs.promises.readFile(configShPath, "utf8");
        configSh = configSh.replace(
          /# Check dotnet Core.*?^fi$/ms,
          "# Dependency checks removed for container injection",
        );
        await fs.promises.writeFile(configShPath, configSh);
        await fs.promises.writeFile(markerFile, new Date().toISOString());
        debugRunner(`Runner extracted.`);
      }
      for (const staleFile of [".runner", ".credentials", ".credentials_rsaparams"]) {
        try {
          fs.rmSync(path.join(hostRunnerSeedDir, staleFile));
        } catch {
          /* not present */
        }
      }
      execSync(`cp -a "${hostRunnerSeedDir}" "${hostRunnerDir}"`, { stdio: "pipe" });

      const resolvedUrl = `${dockerApiUrl}/${githubRepo}`;
      writeRunnerCredentials(hostRunnerDir, containerName, resolvedUrl);
    }

    if (useDirectContainer) {
      debugRunner(`Pulling ${containerImage}...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(containerImage, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) {
            return reject(err);
          }
          // Track per-layer progress across download and extraction phases
          const downloadProgress = new Map<string, { current: number; total: number }>();
          const extractProgress = new Map<string, { current: number; total: number }>();
          let lastProgressUpdate = 0;
          let currentPhase: "downloading" | "extracting" = "downloading";

          const flushProgress = (force = false) => {
            const map = currentPhase === "downloading" ? downloadProgress : extractProgress;
            if (map.size === 0) {
              return;
            }
            const now = Date.now();
            if (!force && now - lastProgressUpdate < 250) {
              return;
            }
            lastProgressUpdate = now;
            let totalBytes = 0;
            let currentBytes = 0;
            for (const layer of map.values()) {
              totalBytes += layer.total;
              currentBytes += layer.current;
            }
            store?.updateJob(containerName, {
              pullProgress: { phase: currentPhase, currentBytes, totalBytes },
            });
          };

          docker.modem.followProgress(
            stream,
            (err: Error | null) => {
              if (err) {
                return reject(err);
              }
              store?.updateJob(containerName, { pullProgress: undefined });
              resolve();
            },
            (event: {
              status?: string;
              id?: string;
              progressDetail?: { current?: number; total?: number };
            }) => {
              if (!event.id) {
                return;
              }

              const detail = event.progressDetail;
              const hasByteCounts =
                detail &&
                typeof detail.current === "number" &&
                typeof detail.total === "number" &&
                detail.total > 0;

              if (event.status === "Downloading" && hasByteCounts) {
                downloadProgress.set(event.id, {
                  current: detail.current!,
                  total: detail.total!,
                });
              } else if (event.status === "Download complete") {
                const existing = downloadProgress.get(event.id);
                if (existing) {
                  existing.current = existing.total;
                }
              } else if (event.status === "Extracting" && hasByteCounts) {
                const phaseChanged = currentPhase !== "extracting";
                currentPhase = "extracting";
                extractProgress.set(event.id, {
                  current: detail.current!,
                  total: detail.total!,
                });
                // Force update on first extraction event so the phase change is visible immediately
                if (phaseChanged) {
                  flushProgress(true);
                  return;
                }
              } else if (event.status === "Pull complete") {
                const existing = extractProgress.get(event.id);
                if (existing) {
                  existing.current = existing.total;
                }
              } else {
                return;
              }

              flushProgress();
            },
          );
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
      dtuHost,
      useDirectContainer,
      containerName,
    });

    const extraHosts = resolveDockerExtraHosts(dtuHost);

    t0 = Date.now();
    container = await docker.createContainer({
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
        ...(extraHosts ? { ExtraHosts: extraHosts } : {}),
      },
      Tty: true,
    });
    t0 = bt("container-create", t0);

    await workspacePrepPromise;
    t0 = Date.now();
    await container.start();
    bt("container-start", t0);

    // 7. Stream logs ───────────────────────────────────────────────────────────
    const rawStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    let tailDone = false;
    let lastFailedStep: string | null = null;
    let isPaused = false;
    let pausedStepName: string | null = null;
    let pausedAtMs: number | null = null;
    let lastSeenAttempt = 0;
    let isBooting = true;
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
        if (key[0] === 3) {
          process.stdin.setRawMode(false);
          process.exit(130);
        }
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

    // ── Timeline → store updater ──────────────────────────────────────────────
    // Reads timeline.json and the paused signal, then updates the RunStateStore.
    // The render loop in cli.ts reads the store and calls renderRunState().
    const updateStoreFromTimeline = () => {
      try {
        // ── Pause-on-failure: check for paused signal ───────────────────────
        if (pauseOnFailure && fs.existsSync(pausedSignalPath)) {
          const content = fs.readFileSync(pausedSignalPath, "utf-8").trim();
          const lines = content.split("\n");
          pausedStepName = lines[0] || null;
          const attempt = parseInt(lines[1] || "1", 10);
          const isNewAttempt = attempt !== lastSeenAttempt;
          if (isNewAttempt) {
            lastSeenAttempt = attempt;
            isPaused = true;
            pausedAtMs = Date.now();
            setupStdinRetry();
          }

          // Read output captured by the wrapper script's tee — written directly
          // to the signals dir so it's always available when paused.
          const tailLines = tailLogFile(path.join(dirs.signalsDir, "step-output"), 20);

          store?.updateJob(containerName, {
            status: "paused",
            pausedAtStep: pausedStepName || undefined,
            ...(isNewAttempt && pausedAtMs !== null
              ? { pausedAtMs: new Date(pausedAtMs).toISOString(), attempt: lastSeenAttempt }
              : {}),
            lastOutputLines: tailLines,
          });
        } else if (isPaused && !fs.existsSync(pausedSignalPath)) {
          // Pause signal removed — job is retrying
          isPaused = false;
          pausedAtMs = null;
          store?.updateJob(containerName, { status: "running", pausedAtMs: undefined });
        }

        if (!fs.existsSync(timelinePath)) {
          return;
        }

        const records = JSON.parse(fs.readFileSync(timelinePath, "utf-8")) as any[];
        const steps = records
          .filter((r) => r.type === "Task" && r.name)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

        if (steps.length === 0) {
          return;
        }

        // ── Transition from booting to running on first timeline entry ────────
        if (isBooting) {
          isBooting = false;
          bt("total", bootStart);
          store?.updateJob(containerName, {
            status: isPaused ? "paused" : "running",
            bootDurationMs: Date.now() - bootStart,
          });
        }

        // ── Build StepState[] from timeline records ───────────────────────────
        const seenNames = new Set<string>();
        let hasPostSteps = false;
        let completeJobRecord: any = null;

        const preCountNames = new Set<string>();
        for (const r of steps) {
          if (!preCountNames.has(r.name)) {
            preCountNames.add(r.name);
          } else {
            hasPostSteps = true;
          }
        }
        const hasCompleteJob = preCountNames.has("Complete job");
        // Total = unique names (minus "Complete job") + "Post Setup" (if any) + "Complete job"
        const totalSteps =
          preCountNames.size -
          (hasCompleteJob ? 1 : 0) +
          (hasPostSteps ? 1 : 0) +
          (hasCompleteJob ? 1 : 0);
        const padW = String(totalSteps).length;

        let stepIdx = 0;
        const newSteps: StepState[] = [];

        for (const r of steps) {
          if (seenNames.has(r.name)) {
            continue;
          }
          seenNames.add(r.name);

          if (r.name === "Complete job") {
            completeJobRecord = r;
            continue;
          }
          stepIdx++;

          const durationMs =
            r.startTime && r.finishTime
              ? new Date(r.finishTime).getTime() - new Date(r.startTime).getTime()
              : undefined;

          let status: StepState["status"];
          if (!r.result && r.state !== "completed") {
            if (r.startTime) {
              status = isPaused && pausedStepName === r.name ? "paused" : "running";
            } else {
              status = "pending";
            }
          } else {
            const result = (r.result || "").toLowerCase();
            if (result === "failed") {
              lastFailedStep = r.name;
              status = "failed";
            } else if (result === "skipped") {
              status = "skipped";
            } else {
              status = "completed";
            }
          }

          newSteps.push({
            name: r.name,
            index: stepIdx,
            status,
            startedAt: r.startTime,
            completedAt: r.finishTime,
            durationMs,
          });
          void padW; // used for totalSteps calculation above
        }

        const jobFinished = !!completeJobRecord?.result;

        if (hasPostSteps && jobFinished) {
          stepIdx++;
          newSteps.push({ name: "Post Setup", index: stepIdx, status: "completed" });
        }

        if (completeJobRecord && jobFinished) {
          stepIdx++;
          const durationMs =
            completeJobRecord.startTime && completeJobRecord.finishTime
              ? new Date(completeJobRecord.finishTime).getTime() -
                new Date(completeJobRecord.startTime).getTime()
              : undefined;
          newSteps.push({
            name: "Complete job",
            index: stepIdx,
            status: "completed",
            startedAt: completeJobRecord.startTime,
            completedAt: completeJobRecord.finishTime,
            durationMs,
          });
        }

        // Compute total duration from timeline step times
        let totalDurationMs: number | undefined;
        if (jobFinished) {
          const allTimes = steps
            .filter((r) => r.startTime && r.finishTime)
            .map((r) => ({
              start: new Date(r.startTime).getTime(),
              end: new Date(r.finishTime).getTime(),
            }));
          if (allTimes.length > 0) {
            const earliest = Math.min(...allTimes.map((t) => t.start));
            const latest = Math.max(...allTimes.map((t) => t.end));
            const ms = latest - earliest;
            if (!isNaN(ms) && ms >= 0) {
              totalDurationMs = ms;
            }
          }
        }

        store?.updateJob(containerName, {
          steps: newSteps,
          ...(jobFinished
            ? {
                status: lastFailedStep ? "failed" : "completed",
                failedStep: lastFailedStep || undefined,
                durationMs: totalDurationMs,
              }
            : {}),
        });
      } catch {
        // Best-effort
      }
    };

    const pollPromise = (async () => {
      while (!tailDone) {
        updateStoreFromTimeline();
        await new Promise((r) => setTimeout(r, 100));
      }
      // Final update
      updateStoreFromTimeline();
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

      containerWaitPromise
        .then(() => {
          (rawStream as any).destroy?.();
        })
        .catch(() => {});
    });

    tailDone = true;
    cleanupStdin();
    await pollPromise;

    // 8. Wait for completion
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
      debugRunner(
        `Runner did not exit within ${CONTAINER_EXIT_TIMEOUT_MS / 1000}s, force-stopping container…`,
      );
      try {
        await container.stop({ t: 5 });
      } catch {
        /* already stopped */
      }
      waitResult = await container.wait();
    }
    const containerExitCode = waitResult.StatusCode;

    const jobSucceeded = lastFailedStep === null && containerExitCode === 0;

    // Update store with final exit code on failure
    if (!jobSucceeded) {
      store?.updateJob(containerName, {
        failedExitCode: containerExitCode !== 0 ? containerExitCode : undefined,
      });
    }

    await new Promise<void>((resolve) => debugStream.end(resolve));

    // Read step outputs captured by the DTU server via the runner's outputs API
    let stepOutputs: Record<string, string> = {};
    if (jobSucceeded) {
      const outputsFile = path.join(logDir, "outputs.json");
      try {
        if (fs.existsSync(outputsFile)) {
          stepOutputs = JSON.parse(fs.readFileSync(outputsFile, "utf-8"));
        }
      } catch {
        /* best-effort */
      }
    }

    if (jobSucceeded && fs.existsSync(dirs.containerWorkDir)) {
      try {
        fs.rmSync(dirs.containerWorkDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup — ENOTEMPTY can occur when container
        // processes haven't fully released file handles yet.
      }
    }

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
      stepOutputs,
    });
  } finally {
    // Cleanup: always runs even when errors occur mid-run.
    try {
      await container?.remove({ force: true });
    } catch {
      /* already removed */
    }
    if (serviceCtx) {
      await cleanupServiceContainers(docker, serviceCtx, (line) => debugRunner(line));
    }
    if (fs.existsSync(dirs.shimsDir)) {
      fs.rmSync(dirs.shimsDir, { recursive: true, force: true });
    }
    if (!pauseOnFailure && fs.existsSync(dirs.signalsDir)) {
      fs.rmSync(dirs.signalsDir, { recursive: true, force: true });
    }
    if (fs.existsSync(dirs.diagDir)) {
      fs.rmSync(dirs.diagDir, { recursive: true, force: true });
    }
    if (fs.existsSync(hostRunnerDir)) {
      fs.rmSync(hostRunnerDir, { recursive: true, force: true });
    }
    await ephemeralDtu?.close().catch(() => {});
    process.removeListener("SIGINT", signalCleanup);
    process.removeListener("SIGTERM", signalCleanup);
  }
}
