import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "./index.js";
import { getEventLog, clearEventLog } from "./orchestrator.js";

describe("DTU Lifecycle", () => {
  it("full lifecycle: start → SSE events → stop → SSE events", async () => {
    clearEventLog();

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

    // Wait for process to fully exit
    await new Promise((resolve) => setTimeout(resolve, 5000));

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
