import { describe, it, expect } from "vitest";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  it("allows up to `limit` concurrent holders", async () => {
    const sem = createSemaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();

    let third: (() => void) | null = null;
    const p3 = sem.acquire().then((r) => {
      third = r;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(third).toBeNull();

    r1();
    await p3;
    expect(third).not.toBeNull();

    r2();
    third!();
  });

  it("serves waiters FIFO", async () => {
    const sem = createSemaphore(1);
    const r1 = await sem.acquire();
    const order: number[] = [];
    const p2 = sem.acquire().then((r) => {
      order.push(2);
      r();
    });
    const p3 = sem.acquire().then((r) => {
      order.push(3);
      r();
    });
    r1();
    await Promise.all([p2, p3]);
    expect(order).toEqual([2, 3]);
  });

  it("rejects a non-positive limit", () => {
    expect(() => createSemaphore(0)).toThrow();
    expect(() => createSemaphore(-1)).toThrow();
    expect(() => createSemaphore(1.5)).toThrow();
  });
});
