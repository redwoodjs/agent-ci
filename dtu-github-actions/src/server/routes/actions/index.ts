import { Polka } from "polka";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { state } from "../../store.js";
import { getBaseUrl } from "../dtu.js";
import { createJobResponse } from "./generators.js";

// Helper to reliably find log Id from URLs like /_apis/distributedtask/hubs/Hub/plans/Plan/logs/123
export function registerActionRoutes(app: Polka) {
  // 7. Pipeline Service Discovery Mock
  const serviceDiscoveryHandler = (req: any, res: any) => {
    console.log(`[DTU] Handling service discovery: ${req.url}`);
    const baseUrl = getBaseUrl(req);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        value: [],
        locationId: crypto.randomUUID(),
        instanceId: crypto.randomUUID(),
        locationServiceData: {
          serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
          defaultAccessMappingMoniker: "PublicAccessMapping",
          accessMappings: [
            { moniker: "PublicAccessMapping", displayName: "Public Access", accessPoint: baseUrl },
          ],
          serviceDefinitions: [
            {
              serviceType: "distributedtask",
              identifier: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              displayName: "distributedtask",
              relativeToSetting: 3,
              relativePath: "",
              description: "Distributed Task Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              status: 1, // Online
              locationMappings: [
                { accessMappingMoniker: "PublicAccessMapping", location: baseUrl },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", // Pools
              displayName: "Pools",
              relativeToSetting: 3,
              relativePath: "/_apis/distributedtask/pools",
              description: "Pools Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              status: 1,
              locationMappings: [
                {
                  accessMappingMoniker: "PublicAccessMapping",
                  location: `${baseUrl}/_apis/distributedtask/pools`,
                },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "27d7f831-88c1-4719-8ca1-6a061dad90eb", // ActionDownloadInfo
              displayName: "ActionDownloadInfo",
              relativeToSetting: 3,
              relativePath:
                "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo",
              description: "Action Download Info Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              status: 1,
              locationMappings: [
                { accessMappingMoniker: "PublicAccessMapping", location: `${baseUrl}` },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "858983e4-19bd-4c5e-864c-507b59b58b12", // AppendTimelineRecordFeedAsync
              displayName: "AppendTimelineRecordFeed",
              relativeToSetting: 3,
              relativePath:
                "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed",
              description: "Timeline Feed Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              status: 1,
              locationMappings: [
                { accessMappingMoniker: "PublicAccessMapping", location: `${baseUrl}` },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "46f5667d-263a-4684-91b1-dff7fdcf64e2", // AppendLogContent
              displayName: "TaskLog",
              relativeToSetting: 3,
              relativePath: "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}",
              description: "Task Log Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              status: 1,
              locationMappings: [
                { accessMappingMoniker: "PublicAccessMapping", location: `${baseUrl}` },
              ],
            },
          ],
        },
      }),
    );
  };

  app.get("/_apis/pipelines", serviceDiscoveryHandler);
  app.get("/_apis/connectionData", serviceDiscoveryHandler);

  // 10. Pools Handler
  app.get("/_apis/distributedtask/pools", (req, res) => {
    console.log(`[DTU] Handling pools request`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        count: 1,
        value: [{ id: 1, name: "Default", isHosted: false, autoProvision: true }],
      }),
    );
  });

  // 11. Agents Handler
  app.get("/_apis/distributedtask/pools/:poolId/agents", (req: any, res) => {
    console.log(`[DTU] Handling get agents request`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: 0, value: [] }));
  });

  app.post("/_apis/distributedtask/pools/:poolId/agents", (req: any, res) => {
    console.log(`[DTU] Handling register agent request`);
    const payload = req.body;
    const agentId = Math.floor(Math.random() * 10000);
    const baseUrl = getBaseUrl(req);

    const response = {
      id: agentId,
      name: payload?.name || "oa-runner",
      version: payload?.version || "2.331.0",
      osDescription: payload?.osDescription || "Linux",
      ephemeral: payload?.ephemeral || true,
      disableUpdate: payload?.disableUpdate || true,
      enabled: true,
      status: "online",
      provisioningState: "Provisioned",
      authorization: {
        clientId: crypto.randomUUID(),
        authorizationUrl: `${baseUrl}/auth/authorize`,
      },
      accessPoint: `${baseUrl}/_apis/distributedtask/pools/${req.params.poolId}/agents/${agentId}`,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  // 12. Sessions Handler
  app.post("/_apis/distributedtask/pools/:poolId/sessions", (req: any, res) => {
    console.log(`[DTU] Creating session for pool ${req.params.poolId}`);
    const newSessionId = crypto.randomUUID();

    const ownerName = req.body?.agent?.name || "oa-runner";

    // Map this session to the runner name, allowing concurrent jobs to find their logs
    state.sessionToRunner.set(newSessionId, ownerName);

    const response = {
      sessionId: newSessionId,
      ownerName: ownerName,
      agent: {
        id: 1,
        name: ownerName,
        version: "2.331.0",
        osDescription: "Linux",
        enabled: true,
        status: "online",
      },
      encryptionKey: {
        value: Buffer.from(crypto.randomBytes(32)).toString("base64"),
        k: "encryptionKey",
      },
    };

    state.sessions.set(newSessionId, response);
    state.messageQueues.set(newSessionId, []);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  app.delete("/_apis/distributedtask/pools/:poolId/sessions/:sessionId", (req: any, res) => {
    const sessionId = req.params.sessionId;
    console.log(`[DTU] Deleting session ${sessionId}`);

    const pending = state.pendingPolls.get(sessionId);
    if (pending && !pending.res.writableEnded) {
      pending.res.writeHead(204);
      pending.res.end();
    }
    state.pendingPolls.delete(sessionId);
    state.sessions.delete(sessionId);
    state.messageQueues.delete(sessionId);
    state.sessionToRunner.delete(sessionId);

    res.writeHead(204);
    res.end();
  });

  // 13. Messages Long Polling
  app.get("/_apis/distributedtask/pools/:poolId/messages", (req: any, res) => {
    const sessionId = req.query.sessionId;
    const baseUrl = getBaseUrl(req);

    if (!sessionId || !state.sessions.has(sessionId)) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }

    const existing = state.pendingPolls.get(sessionId);
    if (existing) {
      existing.res.writeHead(204);
      existing.res.end();
    }
    state.pendingPolls.set(sessionId, { res, baseUrl });

    if (state.jobs.size > 0) {
      const [[jobId, jobData]] = Array.from(state.jobs.entries());

      try {
        const planId = crypto.randomUUID();

        // Concurrency mapping
        const runnerName = state.sessionToRunner.get(sessionId);
        if (runnerName) {
          const logDir = state.runnerLogs.get(runnerName);
          if (logDir) {
            state.planToLogPath.set(planId, path.join(logDir, "step-output.log"));
          }
        }

        const response = createJobResponse(jobId, jobData, baseUrl, planId);
        // Map timelineId → runner's timeline dir (supervisor's _/logs/<runnerName>/)
        try {
          const jobBody = JSON.parse(response.Body);
          const timelineId = jobBody?.Timeline?.Id;
          const tDir = runnerName ? state.runnerTimelineDirs.get(runnerName) : undefined;
          if (timelineId && tDir) {
            state.timelineToLogDir.set(timelineId, tDir);
          }
        } catch {
          /* best-effort */
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        state.jobs.delete(jobId);
        state.pendingPolls.delete(sessionId);
        return;
      } catch (e) {
        console.error(`[DTU] Error creating job response:`, e);
        res.writeHead(500);
        res.end("Internal Server Error generating job");
        return;
      }
    }

    // Long poll: Wait up to 20 seconds before returning empty
    const timeout = setTimeout(() => {
      const pending = state.pendingPolls.get(sessionId);
      if (pending && pending.res === res) {
        state.pendingPolls.delete(sessionId);
        if (!res.writableEnded) {
          res.writeHead(204);
          res.end();
        }
      }
    }, 20000);

    res.on("close", () => {
      clearTimeout(timeout);
      const pending = state.pendingPolls.get(sessionId);
      if (pending && pending.res === res) {
        state.pendingPolls.delete(sessionId);
      }
    });
  });

  app.delete("/_apis/distributedtask/pools/:poolId/messages", (req: any, res) => {
    console.log(
      `[DTU] Acknowledging/Deleting message ${req.query?.messageId} for session ${req.query?.sessionId}`,
    );
    res.writeHead(204);
    res.end();
  });

  // 14. Job Request Update / Renewal Mock
  app.patch("/_apis/distributedtask/jobrequests", (req: any, res) => {
    let payload = req.body || {};
    payload.lockedUntil = new Date(Date.now() + 60000).toISOString();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });

  // 15. Timeline Records Handler — disk-only, no in-memory storage
  const timelineHandler = (req: any, res: any) => {
    const timelineId = req.params.timelineId;
    const payload = req.body || {};
    const newRecords: any[] = payload.value || [];

    // Resolve the file to write to
    const logDir = state.timelineToLogDir.get(timelineId);
    const filePath = logDir ? path.join(logDir, "timeline.json") : null;

    // Read existing records from disk (if any)
    let existing: any[] = [];
    if (filePath) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        /* file doesn't exist yet or is empty */
      }
    }

    // Merge: update existing record by id or append
    for (const record of newRecords) {
      const idx = existing.findIndex((r: any) => r.id === record.id);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...record };
      } else {
        existing.push(record);
      }
    }

    // Persist to disk
    if (filePath) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
      } catch {
        /* best-effort */
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: existing.length, value: existing }));
  };

  // The runner will hit this depending on the route provided in discovery
  app.patch("/_apis/distributedtask/timelines/:timelineId/records", timelineHandler);
  app.post("/_apis/distributedtask/timelines/:timelineId/records", timelineHandler); // fallback

  // 18. Generic Step Outputs Handler
  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/outputs", (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ value: {} }));
  });

  // 18. Resolve Action Download Info Mock
  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/actiondownloadinfo", (req: any, res) => {
    const payload = req.body || {};
    const actions = payload.actions || [];
    const result: any = { actions: {} };

    for (const action of actions) {
      const key = `${action.nameWithOwner}@${action.ref}`;
      const downloadUrl = `https://api.github.com/repos/${action.nameWithOwner}/tarball/${action.ref}`;

      result.actions[key] = {
        nameWithOwner: action.nameWithOwner,
        resolvedNameWithOwner: action.nameWithOwner,
        ref: action.ref,
        resolvedSha: crypto
          .createHash("sha1")
          .update(`${action.nameWithOwner}@${action.ref}`)
          .digest("hex"),
        tarballUrl: downloadUrl,
        zipballUrl: downloadUrl.replace("tarball", "zipball"),
        authentication: null,
      };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  });

  // 19. Generic Job Retrieval Handler
  app.get("/_apis/distributedtask/pools/:poolId/jobs/:jobId", (req, res) => {
    res.writeHead(200);
    res.end(JSON.stringify({ id: "1", name: "job", status: "completed" }));
  });

  // 16. Log Creation Handler (POST .../logs)
  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/logs", (req: any, res: any) => {
    const logId = Math.floor(Math.random() * 10000).toString();
    state.logs.set(logId, []);
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: logId, state: "Created" }));
  });

  // 17. Log Line Appending Handler (POST .../logs/:logId/lines)
  app.post(
    "/_apis/distributedtask/hubs/:hub/plans/:planId/logs/:logId/lines",
    (req: any, res: any) => {
      const logId = req.params.logId;
      const payload = req.body || {};
      const lines = (payload.value || []).map((l: any) => l.message || l);

      const existing = state.logs.get(logId) || [];
      existing.push(...lines);
      state.logs.set(logId, existing);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, value: [] }));
    },
  );

  // Helper to append lines to the concurrent runner's log file
  const writeStepOutputLines = (planId: string, lines: string[]) => {
    const logPath = state.planToLogPath.get(planId);
    if (!logPath) {
      return;
    }

    const RUNNER_INTERNAL_RE =
      /^\[(?:RUNNER|WORKER) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z (?:INFO|WARN|ERR)\s/;
    let content = "";

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (
        !line ||
        line.startsWith("##[") ||
        line.startsWith("[command]") ||
        RUNNER_INTERNAL_RE.test(line)
      ) {
        continue;
      }
      content += line + "\n";
    }

    if (content) {
      try {
        fs.appendFileSync(logPath, content);
      } catch {
        /* best-effort */
      }
    }
  };

  // 19. Append Timeline Record Feed (JSON feed items)
  app.post(
    "/_apis/distributedtask/hubs/:hub/plans/:planId/timelines/:timelineId/records/:recordId/feed",
    (req: any, res: any) => {
      const payload = req.body || {};
      const planId = req.params.planId;
      const extractedLines: string[] = [];

      if (payload.value && Array.isArray(payload.value)) {
        for (const l of payload.value) {
          extractedLines.push(typeof l === "string" ? l : (l.message ?? ""));
        }
      } else if (Array.isArray(payload)) {
        for (const l of payload) {
          extractedLines.push(typeof l === "string" ? l : JSON.stringify(l));
        }
      }

      if (extractedLines.length > 0) {
        writeStepOutputLines(planId, extractedLines);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, value: [] }));
    },
  );
}
