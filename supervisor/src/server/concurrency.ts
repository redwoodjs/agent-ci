import os from "node:os";

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
 * Determine the default max concurrent jobs based on the host CPU count.
 * Returns floor(cpuCount / 2), with a minimum of 1.
 */
export function getDefaultMaxConcurrentJobs(): number {
  const cpuCount = os.cpus().length;
  return Math.max(1, Math.floor(cpuCount / 2));
}
