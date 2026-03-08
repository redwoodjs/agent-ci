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
import { buildJobResult } from "./result-builder.js";

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
    logUpdate(`  ${workflowBasename}\n    └── ${frame} Starting runner (${elapsed}s)`);
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

    await container.start();

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

    let tailDone = false;
    let lastFailedStep: string | null = null;
    const timelinePath = path.join(logDir, "timeline.json");

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

        for (const r of steps) {
          // Post-job cleanup steps share the same name as an earlier step — skip them.
          if (seenNames.has(r.name)) {
            hasPostSteps = true;
            continue;
          }
          seenNames.add(r.name);

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
              stepNodes.push({ label: `${frame} ${stepName} (${stepElapsed}s...)` });
            } else {
              stepNodes.push({ label: `[ ] ${stepName}` });
            }
            continue;
          }

          // Step completed
          const result = (r.result || "").toLowerCase();
          if (result === "failed") {
            lastFailedStep = r.name;
            stepNodes.push({ label: `[✗] ${stepName}${dur}` });
          } else if (result === "skipped") {
            stepNodes.push({ label: `[⊘] ${stepName}${dur}` });
          } else {
            stepNodes.push({ label: `[✓] ${stepName}${dur}` });
          }
        }

        // Ensure "Complete job" is always last, with "Post Setup" before it
        const completeIdx = stepNodes.findIndex((n) => n.label.includes("Complete job"));
        const completeNode = completeIdx >= 0 ? stepNodes.splice(completeIdx, 1)[0] : null;
        if (hasPostSteps) {
          stepNodes.push({ label: "[✓] Post Setup" });
        }
        if (completeNode) {
          stepNodes.push(completeNode);
        }

        // Build the full tree: workflow → Starting runner + job → steps
        const totalMs = Date.now() - bootStart;
        const startingNode: TreeNode = {
          label: spinnerInterval
            ? `${spinnerFrames[spinnerIdx % spinnerFrames.length]} Starting runner`
            : `Starting runner (${fmtMs(bootDurationMs)})`,
        };
        const tree: TreeNode[] = [
          {
            label: `${workflowBasename} (${fmtMs(totalMs)})`,
            children: [
              startingNode,
              {
                label: `${job.taskId ?? "job"}`,
                children: stepNodes,
              },
            ],
          },
        ];

        logUpdate(renderTree(tree));
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
