import { Polka } from "polka";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { state } from "../store.js";
import { createJobResponse } from "./actions/generators.js";

// Base URL extractor middleware (to handle localhost vs host.docker.internal properly)
export function getBaseUrl(req: any) {
  let host = req.headers.host || `localhost`;
  const protocol = req.headers["x-forwarded-proto"] || "http";
  return `${protocol}://${host}`;
}

export function registerDtuRoutes(app: Polka) {
  // 1. Internal Seeding Endpoint
  app.post("/_dtu/seed", (req: any, res) => {
    try {
      const payload = req.body;
      const jobId = payload.id?.toString();

      if (jobId) {
        const mappedSteps = (payload.steps || []).map((step: any) => ({
          ...step,
          Id: crypto.randomUUID(),
        }));

        state.jobs.set(jobId, { ...payload, steps: mappedSteps });
        console.log(`[DTU] Seeded job: ${jobId}`);

        // Notify any pending polls immediately
        const baseUrl = getBaseUrl(req);
        for (const [sessionId, { res: pollRes, baseUrl: runnerBaseUrl }] of state.pendingPolls) {
          console.log(`[DTU] Notifying session ${sessionId} of new job ${jobId}`);

          const planId = crypto.randomUUID();

          // Map this planId to this specific runner's log path
          const runnerName = state.sessionToRunner.get(sessionId);
          if (runnerName) {
            const logDir = state.runnerLogs.get(runnerName);
            if (logDir) {
              state.planToLogPath.set(planId, path.join(logDir, "step-output.log"));
            }
          }

          pollRes.writeHead(200, { "Content-Type": "application/json" });
          pollRes.end(
            JSON.stringify(createJobResponse(jobId, payload, runnerBaseUrl || baseUrl, planId)),
          );
          state.pendingPolls.delete(sessionId);
        }

        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", jobId }));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing job ID" }));
      }
    } catch (err) {
      console.error("[DTU] Seed error", err);
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });

  // POST /_dtu/start-runner
  // Called by localJob.ts when spawning a runner container
  app.post("/_dtu/start-runner", (req: any, res) => {
    try {
      const { runnerName, logDir } = req.body;
      if (runnerName && logDir) {
        fs.mkdirSync(logDir, { recursive: true });
        const stepOutputPath = path.join(logDir, "step-output.log");
        fs.writeFileSync(stepOutputPath, ""); // Truncate/create fresh

        // Register this runner mapping so we can route logs later
        state.runnerLogs.set(runnerName, logDir);
        console.log(`[DTU] Registered runner ${runnerName} with logs at ${logDir}`);
      }
    } catch (e) {
      console.warn("[DTU] start-runner parse error:", e);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  // Debug: Dump State
  app.get("/_dtu/dump", (req, res) => {
    const dump = {
      jobs: Object.fromEntries(state.jobs),
      timelines: Object.fromEntries(state.timelines),
      logs: Object.fromEntries(state.logs),
      runnerLogs: Object.fromEntries(state.runnerLogs),
      sessionToRunner: Object.fromEntries(state.sessionToRunner),
      planToLogPath: Object.fromEntries(state.planToLogPath),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dump));
  });
}
