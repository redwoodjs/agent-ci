import polka from "polka";
import bodyParser from "body-parser";
import { execa } from "execa";
import fs from "node:fs";
import { config } from "../config.js";
import { state } from "./store.js";
import { setupDtuLogging, DTU_LOG_PATH } from "./logger.js";

// Routes
import { registerDtuRoutes } from "./routes/dtu.js";
import { registerGithubRoutes } from "./routes/github.js";
import { registerActionRoutes } from "./routes/actions/index.js";

async function terminateOldProcess() {
  // Kill existing process on DTU port
  try {
    await execa("kill", ["-9", `$(lsof -t -i:${config.DTU_PORT})`], { shell: true, reject: false });
  } catch {
    // Ignore error if no process found
  }
}

export async function bootstrapAndReturnApp() {
  setupDtuLogging();
  state.reset();
  await terminateOldProcess();

  const app = polka();

  // Middleware
  app.use(bodyParser.json({ limit: "50mb" }));
  // Text parser for raw log uploads (resource 46f5667d)
  app.use(bodyParser.text({ type: ["text/plain", "application/octet-stream"], limit: "50mb" }));

  // Routes
  registerDtuRoutes(app);
  registerGithubRoutes(app);
  registerActionRoutes(app);

  // Raw plain text log uploads via stream / catchall logs endpoint
  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/logs/:logId", (req: any, res) => {
    const text = req.body;
    if (typeof text === "string") {
      const planId = req.params.planId;
      const logPath = state.planToLogPath.get(planId);
      if (logPath) {
        let content = "";
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith("##[") || line.startsWith("[command]")) {
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
      }

      const lineCount = text.split("\n").filter((l: string) => l.trim()).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ id: req.params.logId, lineCount, createdOn: new Date().toISOString() }),
      );
    } else {
      res.writeHead(500);
      res.end();
    }
  });

  app.put("/_apis/distributedtask/hubs/:hub/plans/:planId/logs/:logId", (req: any, res) => {
    const text = req.body;
    if (typeof text === "string") {
      const planId = req.params.planId;
      const logPath = state.planToLogPath.get(planId);
      if (logPath) {
        let content = "";
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith("##[") || line.startsWith("[command]")) {
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
      }

      const lineCount = text.split("\n").filter((l: string) => l.trim()).length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ id: req.params.logId, lineCount, createdOn: new Date().toISOString() }),
      );
    } else {
      res.writeHead(500);
      res.end();
    }
  });

  // Global OPTIONS (CORS & Discovery)
  app.options("/*", (req, res) => {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PATCH, PUT, DELETE",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-TFS-FedAuthRedirect, X-VSS-E2EID, X-TFS-Session",
      "Content-Type": "application/json",
    });

    const responseValue = [
      {
        id: "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE",
        area: "distributedtask",
        resourceName: "pools",
        routeTemplate: "_apis/distributedtask/pools/{poolId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "E298EF32-5878-4CAB-993C-043836571F42",
        area: "distributedtask",
        resourceName: "agents",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/agents/{agentId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "C3A054F6-7A8A-49C0-944E-3A8E5D7ADFD7",
        area: "distributedtask",
        resourceName: "messages",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/messages",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "134E239E-2DF3-4794-A6F6-24F1F19EC8DC",
        area: "distributedtask",
        resourceName: "sessions",
        routeTemplate: "_apis/distributedtask/pools/{poolId}/sessions/{sessionId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
      },
      {
        id: "83597576-CC2C-453C-BEA6-2882AE6A1653",
        area: "distributedtask",
        resourceName: "timelines",
        routeTemplate: "_apis/distributedtask/timelines/{timelineId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "27d7f831-88c1-4719-8ca1-6a061dad90eb",
        area: "distributedtask",
        resourceName: "actiondownloadinfo",
        routeTemplate: "_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "6.0",
        releasedVersion: "6.0",
      },
      {
        id: "858983e4-19bd-4c5e-864c-507b59b58b12",
        area: "distributedtask",
        resourceName: "feed",
        routeTemplate:
          "_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "46f5667d-263a-4684-91b1-dff7fdcf64e2",
        area: "distributedtask",
        resourceName: "logs",
        routeTemplate: "_apis/distributedtask/hubs/{hubName}/plans/{planId}/logs/{logId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "8893BC5B-35B2-4BE7-83CB-99E683551DB4",
        area: "distributedtask",
        resourceName: "records",
        routeTemplate: "_apis/distributedtask/timelines/{timelineId}/records/{recordId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "FC825784-C92A-4299-9221-998A02D1B54F",
        area: "distributedtask",
        resourceName: "jobrequests",
        routeTemplate: "_apis/distributedtask/jobrequests/{jobId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
      {
        id: "0A1EFD25-ABDA-43BD-9629-6C7BDD2E0D60",
        area: "distributedtask",
        resourceName: "jobinstances",
        routeTemplate: "_apis/distributedtask/jobinstances/{jobId}",
        resourceVersion: 1,
        minVersion: "1.0",
        maxVersion: "9.0",
        releasedVersion: "9.0",
      },
    ];

    res.end(JSON.stringify({ count: responseValue.length, value: responseValue }));
  });

  // Health and root APIs discovery
  app.get("/_apis", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: [] }));
  });

  app.get("/", (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "online", seededJobs: state.jobs.size }));
  });

  app.head("/", (req, res) => {
    res.writeHead(200);
    res.end();
  });

  // Catch-all 404 with payload dumping
  app.all("/*", (req: any, res) => {
    console.log(`[DTU] 404 Not Found: ${req.method} ${req.url}`);

    // Dump Headers
    console.log(`[DTU] 404 Debug Headers:`, JSON.stringify(req.headers, null, 2));

    // Dump Body if parsed
    if (req.body && Object.keys(req.body).length > 0) {
      console.log(`[DTU] 404 Debug Body (parsed JSON):`, JSON.stringify(req.body, null, 2));
    } else if (typeof req.body === "string" && req.body.length > 0) {
      console.log(
        `[DTU] 404 Debug Body (raw text):`,
        req.body.substring(0, 500) + (req.body.length > 500 ? "..." : ""),
      );
    }

    res.writeHead(404);
    res.end("Not Found (DTU Mock)");
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}` || process.env.NODE_ENV !== "test") {
  bootstrapAndReturnApp()
    .then((app) => {
      app.listen(config.DTU_PORT, "0.0.0.0", () => {
        console.log(
          `[DTU] OA-RUN-1 Mock GitHub API server running at http://0.0.0.0:${config.DTU_PORT}`,
        );
        console.log(`[DTU] Logging to ${DTU_LOG_PATH}`);
      });
    })
    .catch((err: any) => {
      console.error("[DTU] Failed to start:", err);
      process.exit(1);
    });
}
