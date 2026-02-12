import Docker from "dockerode";
import path from "path";
import fs from "fs";
import { pollJobs } from "./bridge";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const IMAGE = "ghcr.io/actions/actions-runner:latest";
const CONTAINER_NAME = "warm-runner";

let intervalId: NodeJS.Timeout | null = null;

export async function startWarmPool() {
  console.log("[WarmPool] Starting warm pool manager...");

  // Initial check
  await checkAndSpawn();
  await pollJobs();

  // Polling loop
  intervalId = setInterval(async () => {
    try {
      await checkAndSpawn();
      await pollJobs();
    } catch (error) {
      console.error("[WarmPool] Error in polling loop:", error);
    }
  }, 10_000);
}

export async function stopWarmPool() {
  console.log("[WarmPool] Stopping warm pool manager...");
  if (intervalId) clearInterval(intervalId);

  const containers = await docker.listContainers({
    all: true,
    filters: {
      name: [CONTAINER_NAME],
    },
  });

  const warmRunner = containers.find((c) => c.Names.includes(`/${CONTAINER_NAME}`));
  if (warmRunner) {
    console.log(`[WarmPool] Removing container ${warmRunner.Id.substring(0, 12)}...`);
    const container = docker.getContainer(warmRunner.Id);
    await container.remove({ force: true });
    console.log("[WarmPool] Container removed.");
  }
}

async function checkAndSpawn() {
  console.log("[WarmPool] Checking runner status...");

  const containers = await docker.listContainers({
    all: true,
    filters: {
      name: [CONTAINER_NAME],
    },
  });

  const warmRunner = containers.find((c) => c.Names.includes(`/${CONTAINER_NAME}`));

  if (warmRunner) {
    if (warmRunner.State === "running") {
      console.log("[WarmPool] Warm runner is healthy and listening.");
      return;
    } else {
      console.log(`[WarmPool] Found warm runner in state: ${warmRunner.State}. Removing...`);
      const container = docker.getContainer(warmRunner.Id);
      await container.remove({ force: true });
    }
  } else {
    console.log("[WarmPool] No warm runner found.");
  }

  await spawnRunner();
}

async function ensureImage(): Promise<void> {
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
        (event) => {
            // Optional: log progress
        });
      });
    });
    console.log(`[WarmPool] Pull complete.`);
  }
}

async function spawnRunner() {
  console.log("[WarmPool] Spawning new warm runner...");

  try {
     await ensureImage();
  } catch(error: any) {
      console.error("[WarmPool] Failed to pull image:", error.message);
      return;
  }

  const workDir = path.resolve(process.cwd(), "_/work");
  const identityDir = path.resolve(process.cwd(), "_/identity");

  // Ensure directories exist (redundant check but good for safety)
  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
  if (!fs.existsSync(identityDir)) fs.mkdirSync(identityDir, { recursive: true });

  try {
    const container = await docker.createContainer({
      Image: IMAGE,
      name: CONTAINER_NAME,
      Cmd: ["/home/runner/run.sh", "--once"],
      HostConfig: {
        Binds: [
          `${workDir}:/home/runner/_work`,
          `${identityDir}/.runner:/home/runner/.runner`,
          `${identityDir}/.credentials:/home/runner/.credentials`,
          `${identityDir}/.credentials_rsaparams:/home/runner/.credentials_rsaparams`,
          "/var/run/docker.sock:/var/run/docker.sock",
        ],
        AutoRemove: true,
      },
      Tty: true, // Often helpful for runner output
    });

    await container.start();
    console.log(`[WarmPool] Started new runner container: ${container.id.substring(0, 12)}`);
  } catch (error: any) {
    console.error("[WarmPool] Failed to spawn runner:", error.message);
  }
}
