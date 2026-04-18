// Tiny N-slot semaphore for capping concurrent macOS VMs. Apple's
// Virtualization.framework limits the host to 2 concurrent VMs, so we gate
// executeMacosVmJob() through this to avoid hard-failing the 3rd one.

export interface Semaphore {
  acquire(): Promise<() => void>;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`Semaphore limit must be a positive integer, got ${limit}`);
  }
  let active = 0;
  const waiters: Array<() => void> = [];

  const release = () => {
    active--;
    const next = waiters.shift();
    if (next) {
      active++;
      next();
    }
  };

  return {
    acquire(): Promise<() => void> {
      if (active < limit) {
        active++;
        return Promise.resolve(release);
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(() => resolve(release));
      });
    },
  };
}
