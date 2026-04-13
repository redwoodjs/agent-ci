import os from "node:os";
import { execSync } from "node:child_process";

/**
 * A simple Promise-based semaphore that limits how many async tasks
 * execute concurrently. Used by the orchestrator to throttle parallel
 * job launches within a dependency wave.
 */
export function createConcurrencyLimiter(max: number) {
  let running = 0;
  const queue: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (running < max) {
      running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        running++;
        resolve();
      });
    });
  }

  function release(): void {
    running--;
    const next = queue.shift();
    if (next) {
      next();
    }
  }

  return {
    /** Wrap an async function so it respects the concurrency limit. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    /** Current number of active tasks (for testing / logging). */
    get active() {
      return running;
    },
    /** Current queue depth (for testing / logging). */
    get queued() {
      return queue.length;
    },
  };
}

/**
 * Read MemAvailable from inside the Docker VM via /proc/meminfo.
 * This reflects actual free memory accounting for kernel, daemon, caches,
 * and any already-running containers — no hardcoded reserve needed.
 *
 * Falls back to `docker info` MemTotal with a conservative reserve if
 * the busybox approach fails (e.g. busybox not pulled).
 */
function getDockerAvailableMemoryBytes(): number | undefined {
  try {
    const raw = execSync("docker run --rm busybox grep MemAvailable /proc/meminfo", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
    const match = raw.match(/MemAvailable:\s+(\d+)\s+kB/);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    // busybox not available — fall back to docker info
  }

  try {
    const raw = execSync("docker info --format '{{.MemTotal}}'", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    const bytes = Number(raw);
    if (Number.isFinite(bytes) && bytes > 0) {
      return Math.max(0, bytes - 4 * 1024 * 1024 * 1024);
    }
  } catch {
    // Docker not reachable
  }

  return undefined;
}

/** Estimated memory per container: runner binary + Ubuntu + heavy workloads (vitest, full builds). */
const BYTES_PER_CONTAINER = 4 * 1024 * 1024 * 1024; // 4 GB

/**
 * Determine the default max concurrent jobs based on CPU count and available
 * Docker memory. Takes the minimum of both to avoid OOM kills.
 *
 * - CPU-based: floor(cpuCount / 2)
 * - Memory-based: floor(availableMemory / perContainer)
 *
 * Minimum of 1.
 */
export function getDefaultMaxConcurrentJobs(): number {
  const cpuCount = os.cpus().length;
  const cpuLimit = Math.floor(cpuCount / 2);

  const availableMem = getDockerAvailableMemoryBytes();
  if (availableMem == null) {
    return Math.max(1, cpuLimit);
  }

  const memLimit = Math.floor(availableMem / BYTES_PER_CONTAINER);
  return Math.max(1, Math.min(cpuLimit, memLimit));
}
