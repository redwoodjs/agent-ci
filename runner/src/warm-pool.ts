import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { pollJobs, fetchRegistrationToken } from "./bridge";
import { config } from "./config";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const IMAGE = "ghcr.io/actions/actions-runner:latest";
const CONTAINER_PREFIX = "oa-runner-";
const MAX_RUNNERS = 10;

interface RunnerState {
  id: string; // Container ID
  name: string;
  type: "warm" | "active";
  stream?: NodeJS.ReadableStream;
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
    if (this.isRunning) return;
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
    if (this.reconcileInterval) clearInterval(this.reconcileInterval);
    await this.cleanupAll();
  }

  private async reconcile() {
    if (!this.isRunning) return;

    // Filter out runners that might have died unexpectedly (if we missed the exit event)
    // For now, we rely on event listeners, but we could add a docker.listContainers check here for robustness.

    const warmCount = Array.from(this.runners.values()).filter((r) => r.type === "warm").length;
    const totalCount = this.runners.size;

    // n + 1 Rule: We want exactly 1 warm runner.
    if (warmCount < 1 && totalCount < MAX_RUNNERS) {
      // Spawn new warm runner
      console.log(`[WarmPool] Need warm runner (Warm: ${warmCount}, Total: ${totalCount}). Spawning...`);
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
        if (this.processedJobs.has(job.deliveryId)) continue;
        
        console.log(`[WarmPool] Received job: ${job.deliveryId} (LocalSync: ${job.localSync})`);
        this.processedJobs.add(job.deliveryId);

        if (job.localSync) {
            console.log(`[WarmPool] Spawning dedicated local runner for job ${job.deliveryId}`);
            await this.spawnRunner(job);
        }
    }
  }

  private async spawnRunner(job?: any) {
    const runId = this.nextRunnerId++;
    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const containerName = `${CONTAINER_PREFIX}${runId}-${randomSuffix}`;

    const workDir = path.resolve(process.cwd(), "_/work", containerName); // Unique work dir per runner name

    // Ensure directories exist
    if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

    try {
        // Ensure image exists before spawning
        await this.ensureImage();

        console.log(`[WarmPool] Fetching registration token for ${containerName}...`);
        const registrationToken = await fetchRegistrationToken();

        const repoUrl = `https://github.com/${config.GITHUB_REPO}`;

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
                `RUNNER_FLAGS=--ephemeral --unattended --labels opposite-actions`,
                ...(job?.localSync ? [
                    `OA_LOCAL_SYNC=true`,
                    `PATH=/tmp/oa-shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
                    ...(job.headSha ? [`OA_HEAD_SHA=${job.headSha}`] : [])
                ] : []),
            ],
            // Run config.sh before run.sh to properly register the runner with the correct labels
            Cmd: ["bash", "-c", "./config.sh --url $RUNNER_REPOSITORY_URL --token $RUNNER_TOKEN --name $RUNNER_NAME --unattended $RUNNER_FLAGS && ./run.sh --once"],
            HostConfig: {
            Binds: [
                `${workDir}:/home/runner/_work`,
                "/var/run/docker.sock:/var/run/docker.sock",
                ...(job?.localSync ? [
                    `${job.localPath}:/home/runner/_work/${job.githubRepo}/${job.githubRepo}`,
                    ...(await this.prepareShims(containerName))
                ] : [])
            ],
            AutoRemove: !job?.localSync, // Keep local sync containers for debugging
            },
            Tty: true,
        });

        const runnerId = container.id;
        
        // Add to map IMMEDIATELY as warm
        this.runners.set(runnerId, {
            id: runnerId,
            name: containerName,
            type: "warm"
        });

        await container.start();
        console.log(`[WarmPool] Started runner ${containerName} (${runnerId.substring(0, 12)})`);


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
        const stream = await container.logs({
            stdout: true,
            stderr: true,
            follow: true,
            tail: 0
        }) as NodeJS.ReadableStream;

        const runnerState = this.runners.get(runnerId);
        if (runnerState) {
            runnerState.stream = stream;
        }

        stream.on('data', (chunk: Buffer) => {
            const logLine = chunk.toString();
            // console.log(`[Runner ${runnerId.substring(0,6)}] ${logLine.trim()}`); // Verbose

            // Detection logic
            if (logLine.includes("Job") && logLine.includes("message received")) {
                this.markAsActive(runnerId);
            }
        });

        // 2. Monitor Exit
        container.wait().then((result) => {
             console.log(`[WarmPool] Runner ${runnerId.substring(0, 12)} exited with code ${result.StatusCode}`);
             this.handleRunnerExit(runnerId);
        }).catch(err => {
            console.error(`[WarmPool] Error waiting for runner ${runnerId}:`, err);
             this.handleRunnerExit(runnerId);
        });

    } catch (error) {
        console.error(`[WarmPool] Failed to attach to runner ${runnerId}:`, error);
        // If we can't attach, we should probably kill it to be safe, or just let it die.
        this.handleRunnerExit(runnerId);
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

  private handleRunnerExit(runnerId: string) {
    if (this.runners.has(runnerId)) {
        this.runners.delete(runnerId);
        console.log(`[WarmPool] Removed runner ${runnerId.substring(0, 12)} from pool.`);
        // Trigger reconcile to replace it if it was the warm one
        this.reconcile();
    }
  }

  private async cleanupAll() {
    console.log("[WarmPool] Cleaning up all managed runners...");
    // 1. List all containers matching our prefix
    const containers = await docker.listContainers({
        all: true,
        filters: { name: [CONTAINER_PREFIX] }
    });

    for (const c of containers) {
        console.log(`[WarmPool] Killing/Removing ${c.Names[0]}...`);
        try {
            const container = docker.getContainer(c.Id);
            // If running, kill
            if (c.State === 'running') {
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
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err: any) => {
            if (err) reject(err);
            else resolve();
          },
          () => {});
        });
      });
      console.log(`[WarmPool] Pull complete.`);
    }
  }

  private async prepareShims(containerName: string): Promise<string[]> {
    const shimsDir = path.resolve(process.cwd(), "_/shims", containerName);
    if (!fs.existsSync(shimsDir)) fs.mkdirSync(shimsDir, { recursive: true });

    const gitShimPath = path.join(shimsDir, "git");
    const gitShimContent = `#!/bin/bash
case "$1" in
  checkout|fetch|reset|init)
    echo "[OA Shim] Intercepted '$1' to protect local files."
    exit 0
    ;;
  *)
    /usr/bin/git "$@"
    ;;
esac
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

