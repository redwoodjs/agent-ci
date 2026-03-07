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
import { startEphemeralDtu } from "dtu-github-actions/src/ephemeral.js";
import { type JobResult } from "../output/reporter.js";
import logUpdate from "log-update";

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
import { buildJobResult } from "./result-builder.js";

// ─── Docker setup ─────────────────────────────────────────────────────────────

const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
const dockerConfig = dockerHost.startsWith("unix://")
  ? { socketPath: dockerHost.replace("unix://", "") }
  : { host: dockerHost, protocol: "ssh" as const };

const docker = new Docker(dockerConfig);

const IMAGE = "ghcr.io/actions/actions-runner:latest";

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function executeLocalJob(job: Job): Promise<JobResult> {
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

  process.stdout.write(`    Runner: ${containerName}\n`);
  process.stdout.write(`    Dir: ${runDir}\n`);

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
      // The pnpm store is bind-mounted into the container, so there's no need
      // for the runner to tar/gzip it. Tell the DTU to return a synthetic hit
      // for any cache key containing "pnpm" — skipping the 60s+ tar entirely.
      virtualCachePatterns: ["pnpm"],
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

  // ── Preflight spinner ────────────────────────────────────────────────────
  // Shows an animated spinner during the silent setup phase (DTU, workspace
  // copy, container creation/start) so the user knows work is happening.
  const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let spinnerIdx = 0;
  const bootStart = Date.now();
  const spinnerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - bootStart) / 1000);
    logUpdate(
      `  ${spinnerFrames[spinnerIdx++ % spinnerFrames.length]} Starting container (${elapsed}s)`,
    );
  }, 80);

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
    for (const d of [dirs.containerWorkDir, dirs.shimsDir, dirs.diagDir]) {
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

    const seedResponse = await fetch(`${dtuUrl}/_dtu/seed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: job.githubJobId || "1",
        name: "job",
        status: "queued",
        localPath: dirs.workspaceDir,
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
      prepareWorkspace({
        workflowPath: job.workflowPath,
        headSha: job.headSha,
        githubRepo: job.githubRepo,
        workspaceDir: dirs.workspaceDir,
      });
    } catch (err) {
      debugRunner(`Failed to prepare workspace: ${err}. Using host fallback.`);
    }

    // 5. Git shim
    const fakeSha = computeFakeSha(job.headSha);
    writeGitShim(dirs.shimsDir, fakeSha);

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
      // Copy seed to per-container directory so config.sh / run.sh don't race.
      execSync(`cp -a "${hostRunnerSeedDir}" "${hostRunnerDir}"`, { stdio: "pipe" });
      // Remove any stale runner auth files from the copy
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
      diagDir: dirs.diagDir,
      toolCacheDir: dirs.toolCacheDir,
      pnpmStoreDir: dirs.pnpmStoreDir,
      playwrightCacheDir: dirs.playwrightCacheDir,
      warmModulesDir: dirs.warmModulesDir,
      hostRunnerDir,
      useDirectContainer,
    });

    const containerCmd = buildContainerCmd({
      svcPortForwardSnippet,
      dtuPort,
      useDirectContainer,
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

    await container.start();

    // 7. Stream logs ─────────────────────────────────────────────────────────────
    // Use readline so we process complete lines (no split ANSI sequences).
    // Write ALL lines to debug.log; write filtered lines to output.log and stdout.
    const rawStream = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
    })) as NodeJS.ReadableStream;

    // ── Preflight complete — stop spinner before step-list UI takes over ──
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      const bootSec = Math.round((Date.now() - bootStart) / 1000);
      logUpdate(`  ✓ Starting container (${bootSec}s)`);
      logUpdate.done();
    }

    let tailDone = false;
    let lastFailedStep: string | null = null;
    const timelinePath = path.join(logDir, "timeline.json");
    /** Steps we've already emitted a "starting" line for. */
    const seenStarted = new Set<string>();

    const checkTimeline = () => {
      try {
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

        // Separate newly-completed steps from in-progress/pending steps.
        // Completed steps are written permanently via stdout (once).
        // In-progress/pending steps are redrawn via logUpdate each poll.
        const newlyCompleted: { name: string; dur: string; result: string }[] = [];
        let dynamicOutput = "";

        for (const r of steps) {
          const stepKey = r.id ?? r.name;
          let dur = "";
          if (r.startedOn && r.finishedOn) {
            const ms = new Date(r.finishedOn).getTime() - new Date(r.startedOn).getTime();
            if (!isNaN(ms) && ms >= 0) {
              dur = ` (${Math.round(ms / 1000)}s)`;
            }
          }

          // Step hasn't completed yet — add to dynamic output
          if (!r.result && r.state !== "completed") {
            if (r.startedOn) {
              const stepElapsed = Math.round((Date.now() - new Date(r.startedOn).getTime()) / 1000);
              const frame = spinnerFrames[spinnerIdx % spinnerFrames.length];
              dynamicOutput += `    ${frame} ${r.name} (${stepElapsed}s)\n`;
            } else {
              dynamicOutput += `    \u25CB ${r.name}\n`;
            }
            continue;
          }

          // Step completed — collect if not already emitted
          if (!seenStarted.has(stepKey)) {
            seenStarted.add(stepKey);
            const result = (r.result || "").toLowerCase();
            newlyCompleted.push({ name: r.name, dur, result });
            if (result === "failed") {
              lastFailedStep = r.name;
            }
          }
          // Already emitted — skip entirely
        }

        // If we have newly completed steps, clear the dynamic logUpdate content
        // first, then write the permanent lines, then redraw dynamic lines.
        if (newlyCompleted.length > 0) {
          logUpdate.clear();
          for (const s of newlyCompleted) {
            if (s.result === "failed") {
              process.stdout.write(`    \u2717 ${s.name}${s.dur}\n`);
            } else if (s.result === "skipped") {
              process.stdout.write(`    \u2298 ${s.name}${s.dur}\n`);
            } else {
              process.stdout.write(`    \u2713 ${s.name}${s.dur}\n`);
            }
          }
        }

        // Redraw only in-progress/pending steps (overwrites previous dynamic content)
        if (dynamicOutput) {
          logUpdate(dynamicOutput.trimEnd());
        } else {
          logUpdate.clear();
        }
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
