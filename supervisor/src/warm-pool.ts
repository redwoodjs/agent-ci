import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { pollJobs, fetchRegistrationToken } from "./bridge.js";
import { config } from "./config.js";
import { ensureLogDirs, getNextLogNum, finalizeLog, LOGS_DIR, PROJECT_ROOT } from "./logger.js";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const IMAGE = "ghcr.io/actions/actions-runner:latest";
const CONTAINER_PREFIX = "oa-runner-";
const MAX_RUNNERS = 10;

interface RunnerState {
  id: string; // Container ID
  name: string;
  type: "warm" | "active";
  stream?: NodeJS.ReadableStream;
  logPath: string;
  logStream: fs.WriteStream;
  commitSha?: string;
}

export class WarmPool {
  private runners: Map<string, RunnerState> = new Map();
  private isRunning: boolean = false;
  private reconcileInterval: NodeJS.Timeout | null = null;
  private nextRunnerId: number = 1;
  private processedJobs: Set<string> = new Set();

  constructor() {
    this.reconcile = this.reconcile.bind(this);
  }

  public async start() {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    console.log("[WarmPool] Starting warm pool manager...");

    // Cleanup existing runners on start to ensure clean state
    await this.cleanupAll();

    // Initial reconcile
    await this.reconcile();

    // Start periodic reconcile loop (failsafe)
    this.reconcileInterval = setInterval(this.reconcile, 5000);
  }

  public async stop() {
    console.log("[WarmPool] Stopping warm pool manager...");
    this.isRunning = false;
    if (this.reconcileInterval) {
      clearInterval(this.reconcileInterval);
    }
    await this.cleanupAll();
  }

  private async reconcile() {
    if (!this.isRunning) {
      return;
    }

    // Filter out runners that might have died unexpectedly (if we missed the exit event)
    // For now, we rely on event listeners, but we could add a docker.listContainers check here for robustness.

    const warmCount = Array.from(this.runners.values()).filter((r) => r.type === "warm").length;
    const totalCount = this.runners.size;

    // n + 1 Rule: We want exactly 1 warm runner.
    if (warmCount < 1 && totalCount < MAX_RUNNERS) {
      // Spawn new warm runner
      console.log(
        `[WarmPool] Need warm runner (Warm: ${warmCount}, Total: ${totalCount}). Spawning...`,
      );
      await this.spawnRunner();
    } else if (warmCount > 1) {
      // Too many warm runners? (Race condition maybe). We could kill one, or just let it be.
      // For now, we only spawn if < 1.
    }

    if (totalCount >= MAX_RUNNERS && warmCount === 0) {
      console.warn("[WarmPool] Max runners reached. Cannot spawn new warm runner.");
    }

    // Poll the bridge to announce presence and get jobs
    const jobs = await pollJobs();
    for (const job of jobs) {
      if (this.processedJobs.has(job.deliveryId)) {
        continue;
      }

      console.log(`[WarmPool] Received job: ${job.deliveryId} (LocalSync: ${job.localSync})`);
      this.processedJobs.add(job.deliveryId);

      if (job.localSync) {
        console.log(`[WarmPool] Spawning dedicated local runner for job ${job.deliveryId}`);
        await this.spawnRunner(job);
      }
    }
  }

  private async spawnRunner(job?: any) {
    // Compute the container name without creating the log directory yet.
    // This prevents empty directories from accumulating when Docker operations fail.
    ensureLogDirs();
    const num = getNextLogNum("oa-runner");
    const containerName = `oa-runner-${num}`;

    const workDir = path.resolve(PROJECT_ROOT, "_/work", containerName); // Unique work dir per runner name

    // Ensure directories exist
    if (!fs.existsSync(workDir)) {
      fs.mkdirSync(workDir, { recursive: true });
    }

    try {
      // Ensure image exists before spawning
      await this.ensureImage();

      console.log(`[WarmPool] Fetching registration token for ${containerName}...`);
      const registrationToken = await fetchRegistrationToken();

      const dockerApiUrl = config.GITHUB_API_URL.replace(
        "localhost",
        "host.docker.internal",
      ).replace("127.0.0.1", "host.docker.internal");
      const repoUrl = `${dockerApiUrl}/${config.GITHUB_REPO}`;

      console.log(`[WarmPool] Creating container ${containerName}...`);
      const container = await docker.createContainer({
        Image: IMAGE,
        name: containerName,
        // Use config.sh for registration if needed, but the official image
        // usually uses these env vars to auto-configure on startup.
        // Actually, the entrypoint /run.sh handles this if these are set.
        Env: [
          `RUNNER_NAME=${containerName}`,
          `RUNNER_TOKEN=${registrationToken}`,
          `RUNNER_REPOSITORY_URL=${repoUrl}`,
          `GITHUB_API_URL=${dockerApiUrl}`,
          `GITHUB_SERVER_URL=${repoUrl}`,
          `GITHUB_REPOSITORY=${config.GITHUB_REPO}`,
          `http_proxy=${dockerApiUrl}`,
          `https_proxy=${dockerApiUrl}`,
          `no_proxy=`,
          ...(job?.localSync
            ? [
                `OA_LOCAL_SYNC=true`,
                `PATH=/tmp/oa-shims:/home/runner/externals/node20/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                ...(job.headSha ? [`OA_HEAD_SHA=${job.headSha}`] : []),
              ]
            : []),
        ],
        // Run config.sh before run.sh to properly register the runner with the correct labels
        Cmd: [
          "bash",
          "-c",
          "echo \"DEBUG: GITHUB_SERVER_URL=$GITHUB_SERVER_URL\" && echo 'Testing connectivity...' && curl -v $GITHUB_API_URL || echo 'Curl failed' && GITHUB_SERVER_URL=$RUNNER_REPOSITORY_URL GITHUB_API_URL= ./config.sh --url $RUNNER_REPOSITORY_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --unattended --ephemeral --labels opposite-actions || echo 'Config failed (ignoring)...' && REPO_NAME=$(basename $GITHUB_REPOSITORY) && mkdir -p /home/runner/_work/$REPO_NAME/$REPO_NAME && cp -a /tmp/oa-workspace/. /home/runner/_work/$REPO_NAME/$REPO_NAME/ || true && ./run.sh --once",
        ],
        HostConfig: {
          Binds: [
            `${workDir}:/home/runner/_work`,
            "/var/run/docker.sock:/var/run/docker.sock",
            ...(job?.localSync
              ? [`${job.localPath}:/tmp/oa-workspace`, ...(await this.prepareShims(containerName))]
              : []),
          ],
          AutoRemove: !job?.localSync, // Keep local sync containers for debugging
        },
        Tty: true,
      });

      // Container created successfully — now create the log directory
      const logDir = path.join(LOGS_DIR, containerName);
      fs.mkdirSync(logDir, { recursive: true });
      const outputLogPath = path.join(logDir, "output.log");

      const runnerId = container.id;

      const logStream = fs.createWriteStream(outputLogPath, { flags: "a" });

      // Add to map IMMEDIATELY as warm
      this.runners.set(runnerId, {
        id: runnerId,
        name: containerName,
        type: "warm",
        logPath: outputLogPath,
        logStream,
        commitSha: job?.headSha,
      });

      console.log(
        `[WarmPool] Starting container ${containerName} (${runnerId.substring(0, 12)})...`,
      );
      await container.start();
      console.log(`[WarmPool] container.start() resolved for ${containerName}`);

      if (job) {
        await this.seedDTU(job);
      }

      // Attach listeners
      this.attachToRunner(container, runnerId);
    } catch (error: any) {
      console.error(`[WarmPool] Failed to spawn runner ${containerName}:`, error.message);
      // Clean up map if needed (though we added it, it failed start, so maybe not there effectively?)
    }
  }

  private async attachToRunner(container: Docker.Container, runnerId: string) {
    // 1. Monitor Logs for "Job received"
    try {
      const stream = (await container.logs({
        stdout: true,
        stderr: true,
        follow: true,
        tail: 100,
      })) as NodeJS.ReadableStream;

      const runnerState = this.runners.get(runnerId);
      if (runnerState) {
        runnerState.stream = stream;
      }

      stream.on("data", (chunk: Buffer) => {
        const logLine = chunk.toString();
        // console.log(`[Runner ${runnerId.substring(0,6)}] ${logLine.trim()}`); // Verbose

        const runnerState = this.runners.get(runnerId);
        if (runnerState) {
          runnerState.logStream.write(chunk);
        }

        // Detection logic for job assignment
        if (logLine.includes("Job") && logLine.includes("message received")) {
          this.markAsActive(runnerId);
        }

        // Detection logic for critical errors (only if EXIT_ON_ERROR is enabled)
        if (config.EXIT_ON_ERROR) {
          // Ignore "Cannot find GitHub repository..." as it is a benign SystemD error in this context
          if (logLine.includes("Cannot find GitHub repository/organization name from server url")) {
            console.warn(`[WarmPool] Ignoring known benign error: ${logLine.trim()}`);
          }

          // Detect general GitHub Actions runner errors
          if (logLine.includes("[RUNNER") && logLine.includes("ERR")) {
            // Extract the error message for logging
            const errorMatch = logLine.match(/\[RUNNER.*ERR.*\]\s*(.*)/);
            if (errorMatch && errorMatch[1]) {
              const errorMsg = errorMatch[1].trim();
              // Only exit on critical errors, not all errors
              if (
                errorMsg.includes("System.InvalidOperationException") &&
                !errorMsg.includes("Cannot find GitHub repository/organization name")
              ) {
                this.handleCriticalError(errorMsg);
              }
            }
          }
        }
      });

      // 2. Monitor Exit
      container
        .wait()
        .then((result) => {
          console.log(
            `[WarmPool] Runner ${runnerId.substring(0, 12)} exited with code ${result.StatusCode}`,
          );
          this.handleRunnerExit(runnerId, result.StatusCode);
        })
        .catch((err) => {
          console.error(`[WarmPool] Error waiting for runner ${runnerId}:`, err);
          this.handleRunnerExit(runnerId, 1);
        });
    } catch (error) {
      console.error(`[WarmPool] Failed to attach to runner ${runnerId}:`, error);
      // If we can't attach, we should probably kill it to be safe, or just let it die.
      this.handleRunnerExit(runnerId, 1);
    }
  }

  private markAsActive(runnerId: string) {
    const runner = this.runners.get(runnerId);
    if (runner && runner.type === "warm") {
      console.log(`[WarmPool] Runner ${runner.name} picked up a job! Marking as ACTIVE.`);
      runner.type = "active";
      // Trigger reconcile to spawn a new warm runner
      this.reconcile();
    }
  }

  private handleRunnerExit(runnerId: string, exitCode: number = 0) {
    const runner = this.runners.get(runnerId);
    if (runner) {
      console.log(`[WarmPool] Removed runner ${runnerId.substring(0, 12)} from pool.`);

      // Finalize log file
      runner.logStream.end(() => {
        const finalPath = finalizeLog(runner.logPath, exitCode, runner.commitSha, runner.name);
        console.log(`[WarmPool] Log finalized: ${finalPath}`);
      });

      this.runners.delete(runnerId);
      // Trigger reconcile to replace it if it was the warm one
      this.reconcile();
    }
  }

  private async handleCriticalError(errorMessage: string) {
    console.error(`[WarmPool] CRITICAL ERROR DETECTED: ${errorMessage}`);
    console.error(`[WarmPool] Shutting down due to critical error...`);
    await this.stop();
    process.exit(1);
  }

  private async cleanupAll() {
    console.log("[WarmPool] Cleaning up all managed runners...");
    // 1. List all containers matching our prefix
    const containers = await docker.listContainers({
      all: true,
      filters: { name: [CONTAINER_PREFIX] },
    });

    for (const c of containers) {
      console.log(`[WarmPool] Killing/Removing ${c.Names[0]}...`);
      try {
        const container = docker.getContainer(c.Id);
        // If running, kill
        if (c.State === "running") {
          await container.kill().catch(() => {});
        }
        // Remove
        await container.remove({ force: true }).catch(() => {});
      } catch (e) {
        console.error(`[WarmPool] Failed to cleanup ${c.Id}:`, e);
      }
    }
    this.runners.clear();
  }

  private async ensureImage(): Promise<void> {
    const images = await docker.listImages({
      filters: { reference: [IMAGE] },
    });

    if (images.length === 0) {
      console.log(`[WarmPool] Pulling image ${IMAGE}...`);
      await new Promise<void>((resolve, reject) => {
        docker.pull(IMAGE, (err: any, stream: any) => {
          if (err) {
            return reject(err);
          }
          docker.modem.followProgress(
            stream,
            (err: any) => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            },
            () => {},
          );
        });
      });
      console.log(`[WarmPool] Pull complete.`);
    }
  }

  private async seedDTU(job: any) {
    console.log(`[WarmPool] seedDTU called for job ${job.deliveryId}`);
    try {
      const dtuUrl = config.GITHUB_API_URL;
      console.log(`[WarmPool] Sending POST to ${dtuUrl}/_dtu/seed...`);
      const response = await fetch(`${dtuUrl}/_dtu/seed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: job.githubJobId || "1",
          name: "local-job",
          status: "queued",
          ...job,
        }),
      });
      if (!response.ok) {
        console.error(`[WarmPool] Failed to seed DTU: ${response.status}`);
      } else {
        console.log(`[WarmPool] DTU seeded successfully.`);
      }
    } catch (e: any) {
      console.error(`[WarmPool] Error seeding DTU: ${e.message}`);
    }
  }

  private async prepareShims(containerName: string): Promise<string[]> {
    const shimsDir = path.resolve(PROJECT_ROOT, "_/shims", containerName);
    if (!fs.existsSync(shimsDir)) {
      fs.mkdirSync(shimsDir, { recursive: true });
    }

    const gitShimPath = path.join(shimsDir, "git");
    const gitShimContent = `#!/bin/bash

# Check if any argument is checkout, fetch, reset, log, clean, or rm
INTERCEPT=false
for arg in "$@"; do
  if [[ "$arg" == "checkout" || "$arg" == "fetch" || "$arg" == "reset" || "$arg" == "log" || "$arg" == "clean" || "$arg" == "rm" ]]; then
    INTERCEPT=true
    CMD="$arg"
    break
  fi
done

# Check for fetch URL probing
if [[ "$*" == *"config --local --get remote.origin.url"* || "$*" == *"config --get remote.origin.url"* ]]; then
  echo "http://127.0.0.1:80/$GITHUB_REPOSITORY/$GITHUB_REPOSITORY"
  exit 0
fi

if [ "$INTERCEPT" = true ]; then
  echo "[OA Shim] Intercepted '$CMD' to protect local files."
  if [[ "$CMD" == "log" ]]; then
    echo "commit 0000000000000000000000000000000000000000"
  fi
  exit 0
else
  /usr/bin/git "$@"
fi
`;
    fs.writeFileSync(gitShimPath, gitShimContent, { mode: 0o755 });

    return [`${shimsDir}:/tmp/oa-shims`];
  }
}

// Export singleton instance or function wrappers for compatibility
export const warmPool = new WarmPool();

export async function startWarmPool() {
  await warmPool.start();
}

export async function stopWarmPool() {
  await warmPool.stop();
}
