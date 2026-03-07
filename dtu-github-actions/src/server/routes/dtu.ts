import { Polka } from "polka";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { state } from "../store.js";
import { createJobResponse } from "./actions/generators.js";

// Base URL extractor middleware (to handle localhost vs host.docker.internal properly)
// NOTE: strip \r\n from the Host header — HTTP/1.1 runners can include a trailing \r
// which, if embedded in a signed URL, causes Node.js to throw
// "Parse Error: Invalid header value char" when the toolkit uses that URL in a header.
export function getBaseUrl(req: any) {
  const host = (req.headers.host || "localhost").replace(/[\r\n]/g, "").trim();
  const protocol = (req.headers["x-forwarded-proto"] || "http").replace(/[\r\n]/g, "").trim();
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

        const jobPayload = { ...payload, steps: mappedSteps };

        // Store job both in the generic map AND keyed by runner name for per-runner dispatch.
        // The runnerName is passed in the body (from local-job.ts which spreads the Job object).
        const runnerName: string | undefined = payload.runnerName;
        state.jobs.set(jobId, jobPayload);
        if (runnerName) {
          state.runnerJobs.set(runnerName, jobPayload);
        }
        console.log(`[DTU] Seeded job: ${jobId}${runnerName ? ` for runner ${runnerName}` : ""}`);

        // Notify only the pending poll that belongs to this runner (if any already waiting).
        const baseUrl = getBaseUrl(req);
        let notified = false;
        for (const [sessionId, { res: pollRes, baseUrl: runnerBaseUrl }] of state.pendingPolls) {
          const sessRunner = state.sessionToRunner.get(sessionId);
          // Only dispatch to the runner this job was seeded for (or any runner if no runnerName)
          if (runnerName && sessRunner !== runnerName) {
            continue;
          }

          console.log(`[DTU] Notifying session ${sessionId} of new job ${jobId}`);

          const planId = crypto.randomUUID();

          // Map this planId to this specific runner's log path
          if (sessRunner) {
            const logDir = state.runnerLogs.get(sessRunner);
            if (logDir) {
              state.planToLogPath.set(planId, path.join(logDir, "step-output.log"));
            }
          }

          const jobResponse = createJobResponse(
            jobId,
            jobPayload,
            runnerBaseUrl || baseUrl,
            planId,
          );

          // Map timelineId → runner's timeline dir (CLI logs dir)
          try {
            const jobBody = JSON.parse(jobResponse.Body);
            const timelineId = jobBody?.Timeline?.Id;
            const tDir = sessRunner ? state.runnerTimelineDirs.get(sessRunner) : undefined;
            if (timelineId && tDir) {
              state.timelineToLogDir.set(timelineId, tDir);
            }
          } catch {
            /* best-effort */
          }

          pollRes.writeHead(200, { "Content-Type": "application/json" });
          pollRes.end(JSON.stringify(jobResponse));
          state.pendingPolls.delete(sessionId);
          // Remove from runnerJobs since it was dispatched
          if (sessRunner) {
            state.runnerJobs.delete(sessRunner);
          }
          state.jobs.delete(jobId);
          notified = true;
          break;
        }

        if (!notified) {
          console.log(
            `[DTU] No pending poll for job ${jobId} (runner: ${runnerName || "any"}) - job queued`,
          );
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
      const { runnerName, logDir, timelineDir, virtualCachePatterns } = req.body;
      if (runnerName && logDir) {
        fs.mkdirSync(logDir, { recursive: true });
        const stepOutputPath = path.join(logDir, "step-output.log");
        fs.writeFileSync(stepOutputPath, ""); // Truncate/create fresh

        // Register this runner mapping so we can route logs later
        state.runnerLogs.set(runnerName, logDir);
        // Also store the timeline dir (CLI's logs dir) for this runner
        if (timelineDir) {
          state.runnerTimelineDirs.set(runnerName, timelineDir);
        }
        // Register virtual cache key patterns (e.g. "pnpm") so bind-mounted paths
        // skip the tar archive entirely.
        if (Array.isArray(virtualCachePatterns)) {
          for (const pattern of virtualCachePatterns) {
            if (typeof pattern === "string" && pattern.length > 0) {
              state.virtualCachePatterns.add(pattern);
            }
          }
        }
        console.log(
          `[DTU] Registered runner ${runnerName} with logs at ${logDir}${
            timelineDir ? `, timeline at ${timelineDir}` : ""
          }${
            virtualCachePatterns?.length
              ? `, virtual cache patterns: ${virtualCachePatterns.join(", ")}`
              : ""
          }`,
        );
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
      logs: Object.fromEntries(state.logs),
      runnerLogs: Object.fromEntries(state.runnerLogs),
      runnerTimelineDirs: Object.fromEntries(state.runnerTimelineDirs),
      sessionToRunner: Object.fromEntries(state.sessionToRunner),
      planToLogPath: Object.fromEntries(state.planToLogPath),
      timelineToLogDir: Object.fromEntries(state.timelineToLogDir),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dump));
  });
}
