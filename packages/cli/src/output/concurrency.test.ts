import { describe, it, expect } from "vitest";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./concurrency.js";

describe("createConcurrencyLimiter", () => {
  it("limits concurrent execution to max", async () => {
    const limiter = createConcurrencyLimiter(2);
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        // Simulate async work
        await new Promise((r) => setTimeout(r, 50));
        running--;
      });

    await Promise.all([task(), task(), task(), task(), task()]);

    expect(maxRunning).toBe(2);
  });

  it("runs tasks serially when limit is 1", async () => {
    const limiter = createConcurrencyLimiter(1);
    const order: number[] = [];

    const task = (id: number) =>
      limiter.run(async () => {
        order.push(id);
        await new Promise((r) => setTimeout(r, 10));
      });

    await Promise.all([task(1), task(2), task(3)]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("runs all in parallel when limit exceeds task count", async () => {
    const limiter = createConcurrencyLimiter(10);
    let running = 0;
    let maxRunning = 0;

    const task = () =>
      limiter.run(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
      });

    await Promise.all([task(), task(), task()]);

    expect(maxRunning).toBe(3);
  });

  it("propagates errors without deadlocking", async () => {
    const limiter = createConcurrencyLimiter(2);

    const results = await Promise.allSettled([
      limiter.run(async () => {
        throw new Error("boom");
      }),
      limiter.run(async () => "ok"),
      limiter.run(async () => "also ok"),
    ]);

    expect(results[0]).toMatchObject({ status: "rejected" });
    expect(results[1]).toMatchObject({ status: "fulfilled", value: "ok" });
    expect(results[2]).toMatchObject({ status: "fulfilled", value: "also ok" });
  });

  it("exposes active and queued counts", async () => {
    const limiter = createConcurrencyLimiter(1);
    let sawQueued = false;

    const task1 = limiter.run(async () => {
      // At this point task2 should be queued
      await new Promise((r) => setTimeout(r, 50));
    });

    // Give task1 a moment to acquire
    await new Promise((r) => setTimeout(r, 5));

    const task2 = limiter.run(async () => {
      // nothing
    });

    // After task1 acquired, check state
    expect(limiter.active).toBe(1);
    if (limiter.queued > 0) {
      sawQueued = true;
    }

    await Promise.all([task1, task2]);

    expect(sawQueued).toBe(true);
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });
});

describe("getDefaultMaxConcurrentJobs", () => {
  it("returns at least 1", () => {
    const result = getDefaultMaxConcurrentJobs();
    expect(result).toBeGreaterThanOrEqual(1);
  });

  it("returns at most floor(cpuCount / 2)", () => {
    const result = getDefaultMaxConcurrentJobs();
    const os = require("os");
    const cpuLimit = Math.max(1, Math.floor(os.cpus().length / 2));
    expect(result).toBeLessThanOrEqual(cpuLimit);
  });
});
