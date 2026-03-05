import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import request from "supertest";
import { app } from "./index.js";
import { getEventLog, clearEventLog } from "./events.js";
import { setDtuReadinessCheck, setDtuSpawner, resetDtuStateForTest } from "./dtu.js";

// Create a controllable fake child process
function makeFakeProcess() {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 99999;
  proc.kill = () => {
    // Simulate a graceful shutdown (code 0) when killed
    proc.emit("close", 0, null);
  };
  return proc;
}

describe("DTU Lifecycle", () => {
  beforeEach(() => {
    // Reset DTU state and inject test doubles
    resetDtuStateForTest();
    clearEventLog();

    // Readiness check resolves immediately (no real port needed)
    setDtuReadinessCheck(() => Promise.resolve(true));

    // Spawner returns a fake process that stays alive until killed
    setDtuSpawner(() => makeFakeProcess());
  });

  it("full lifecycle: start → SSE events → stop → SSE events", async () => {
    // 1. Initial state should be Stopped
    const initialRes = await request(app.handler as any).get("/dtu");
    expect(initialRes.status).toBe(200);
    expect(initialRes.body.status).toBe("Stopped");

    // 2. Start the DTU
    const startRes = await request(app.handler as any).post("/dtu");
    expect(startRes.status).toBe(200);

    // 3. Verify status is Running
    const runningRes = await request(app.handler as any).get("/dtu");
    expect(runningRes.body.status).toBe("Running");

    // 4. Verify SSE events were broadcast: Starting → Running
    const startEvents = getEventLog().filter((e) => e.type === "dtuStatusChanged");
    const startStatuses = startEvents.map((e) => e.status);
    expect(startStatuses).toContain("Starting");
    expect(startStatuses).toContain("Running");
    expect(startStatuses.indexOf("Starting")).toBeLessThan(startStatuses.indexOf("Running"));

    // Verify events have timestamps
    for (const event of startEvents) {
      expect(event.timestamp).toBeTypeOf("number");
      expect(event.timestamp).toBeGreaterThan(0);
    }

    // 5. Stop the DTU
    clearEventLog();
    const stopRes = await request(app.handler as any).delete("/dtu");
    expect(stopRes.status).toBe(200);

    // Wait for process close event to propagate
    await new Promise((resolve) => setTimeout(resolve, 100));

    // 6. Verify status is Stopped
    const stoppedRes = await request(app.handler as any).get("/dtu");
    expect(stoppedRes.body.status).toBe("Stopped");

    // 7. Verify SSE event was broadcast for Stopped
    const stopEvents = getEventLog().filter((e) => e.type === "dtuStatusChanged");
    const stopStatuses = stopEvents.map((e) => e.status);
    expect(stopStatuses).toContain("Stopped");

    // 8. Verify double-stop is idempotent (no extra SSE events)
    clearEventLog();
    await request(app.handler as any).delete("/dtu");
    const idempotentEvents = getEventLog().filter((e) => e.type === "dtuStatusChanged");
    expect(idempotentEvents).toHaveLength(0);
  }, 30000);
});
