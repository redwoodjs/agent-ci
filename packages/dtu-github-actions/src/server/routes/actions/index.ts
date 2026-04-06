import { Polka } from "polka";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { state, getActionTarballsDir } from "../../store.js";
import { getBaseUrl } from "../dtu.js";
import { createJobResponse } from "./generators.js";

// ─── Action tarball cache ──────────────────────────────────────────────────────
// Downloads action tarballs from GitHub on first use and serves them from disk
// on subsequent runs, eliminating ~30s GitHub CDN download delays.

function actionTarballPath(repoPath: string, ref: string): string {
  const key = `${repoPath.replace("/", "__")}@${ref.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
  return path.join(getActionTarballsDir(), `${key}.tar.gz`);
}

/** Follow redirects and invoke callback with the final response. */
function fetchWithRedirects(
  url: string,
  callback: (res: http.IncomingMessage) => void,
  redirects = 0,
): void {
  if (redirects > 5) {
    return;
  }
  const mod = url.startsWith("https") ? https : http;
  mod.get(url, { headers: { "User-Agent": "agent-ci/1.0" } }, (res) => {
    if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
      res.resume();
      return fetchWithRedirects(res.headers.location, callback, redirects + 1);
    }
    callback(res);
  });
}

// Helper to reliably find log Id from URLs like /_apis/distributedtask/hubs/Hub/plans/Plan/logs/123
export function registerActionRoutes(app: Polka) {
  // ── Action tarball proxy: serves cached tarballs to the runner ──────────────
  // First run: proxies from GitHub while saving to disk (same speed as direct download).
  // Subsequent runs: serves from disk cache instantly (~0ms).
  app.get("/_dtu/action-tarball/:owner/:repo/:ref", (req: any, res) => {
    const { owner, repo, ref } = req.params;
    const repoPath = `${owner}/${repo}`;
    const dest = actionTarballPath(repoPath, ref);

    // Cache hit: serve from disk
    if (fs.existsSync(dest)) {
      const stat = fs.statSync(dest);
      res.writeHead(200, {
        "Content-Type": "application/x-tar",
        "Content-Length": String(stat.size),
      });
      fs.createReadStream(dest).pipe(res as any);
      return;
    }

    // Cache miss: proxy from GitHub, write to disk simultaneously
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const githubUrl = `https://api.github.com/repos/${repoPath}/tarball/${ref}`;
    fetchWithRedirects(githubUrl, (upstream) => {
      if (upstream.statusCode !== 200) {
        res.writeHead(upstream.statusCode ?? 502);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/x-tar" });
      const tmp = dest + ".tmp";
      const file = fs.createWriteStream(tmp);
      upstream.pipe(res as any);
      upstream.pipe(file);
      file.on("finish", () => file.close(() => fs.renameSync(tmp, dest)));
      file.on("error", () => fs.rmSync(tmp, { force: true }));
    });
  });

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
      name: payload?.name || "agent-ci-runner",
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

    const ownerName = req.body?.agent?.name || "agent-ci-runner";

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

    const runnerName = state.sessionToRunner.get(sessionId);

    // First check for a job seeded specifically for this runner, then fall back to the generic pool.
    const runnerSpecificJob = runnerName ? state.runnerJobs.get(runnerName) : undefined;
    const genericJobEntry =
      !runnerSpecificJob && state.jobs.size > 0 ? Array.from(state.jobs.entries())[0] : undefined;

    const jobId = runnerSpecificJob
      ? (runnerName as string) // use runnerName as synthetic key for runner-specific jobs
      : genericJobEntry?.[0];
    const jobData = runnerSpecificJob ?? genericJobEntry?.[1];

    if (jobId && jobData) {
      try {
        const planId = crypto.randomUUID();

        // Concurrency mapping
        if (runnerName) {
          const logDir = state.runnerLogs.get(runnerName);
          if (logDir) {
            state.planToLogDir.set(planId, logDir);
          }
        }

        const response = createJobResponse(jobId, jobData, baseUrl, planId);
        // Map timelineId → runner's timeline dir (CLI's _/logs/<runnerName>/)
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
        // Clean up whichever job store we used
        if (runnerSpecificJob && runnerName) {
          state.runnerJobs.delete(runnerName);
        } else if (genericJobEntry) {
          state.jobs.delete(genericJobEntry[0]);
        }
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

  // 14. Job Request Update / Renewal / Finish Mock
  //     The runner's VssClient resolves the route template "_apis/distributedtask/jobrequests/{jobId}"
  //     but passes { poolId, requestId } as routeValues — since none match "{jobId}", the placeholder
  //     is dropped and the runner sends PATCH /_apis/distributedtask/jobrequests (bare path).
  //     We register both patterns for safety.
  const jobrequestHandler = (req: any, res: any) => {
    let payload = req.body || {};
    // If the request is a renewal (no result/finishTime), set lockedUntil
    if (!payload.result && !payload.finishTime) {
      payload.lockedUntil = new Date(Date.now() + 60000).toISOString();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  app.patch("/_apis/distributedtask/jobrequests", jobrequestHandler);
  app.patch("/_apis/distributedtask/jobrequests/:requestId", jobrequestHandler);

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

    // Merge: update existing record by id, or by order for pre-populated records.
    // Pre-populated records have friendly names from the YAML (e.g., "Build SDK")
    // while DTU records have runner names (e.g., "Run pnpm build"). We want to
    // preserve the friendly name when merging.
    // The runner sends updates with name: null (uses refName instead), so we must
    // strip null values to avoid overwriting existing data.
    for (const record of newRecords) {
      // Strip null values so they don't overwrite existing data
      const nonNull: any = {};
      for (const [k, v] of Object.entries(record)) {
        if (v != null) {
          nonNull[k] = v;
        }
      }

      let mergedIdx = -1;
      const idxById = existing.findIndex((r: any) => r.id === record.id);
      if (idxById >= 0) {
        existing[idxById] = { ...existing[idxById], ...nonNull };
        mergedIdx = idxById;
      } else if (record.order != null) {
        // Try to match by order against pre-populated pending records
        const idxByOrder = existing.findIndex(
          (r: any) => r.order === record.order && r.type === "Task" && r.state === "pending",
        );
        if (idxByOrder >= 0) {
          // Preserve the friendly name from the pre-populated record
          const friendlyName = existing[idxByOrder].name;
          existing[idxByOrder] = { ...existing[idxByOrder], ...nonNull, name: friendlyName };
          mergedIdx = idxByOrder;
        } else {
          existing.push(record);
          mergedIdx = existing.length - 1;
        }
      } else {
        existing.push(record);
        mergedIdx = existing.length - 1;
      }

      // Ensure name is populated: fall back to refName if name is still null
      if (
        mergedIdx >= 0 &&
        existing[mergedIdx] &&
        !existing[mergedIdx].name &&
        existing[mergedIdx].refName
      ) {
        existing[mergedIdx].name = existing[mergedIdx].refName;
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

    // Build recordId/logId → sanitized step name mappings for per-step log files.
    // Also rename any existing files that were written before the mapping was available.
    // logDir is already resolved above from state.timelineToLogDir — reuse it here.
    const stepsDir = logDir ? path.join(logDir, "steps") : undefined;

    for (const record of existing) {
      if (record.name && record.type === "Task") {
        const sanitized = record.name
          .replace(/[^a-zA-Z0-9_.-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 80);

        const ids: string[] = [];
        if (record.id) {
          ids.push(record.id);
        }
        if (record.log?.id) {
          ids.push(String(record.log.id));
        }

        for (const id of ids) {
          state.recordToStepName.set(id, sanitized);
          // Rename existing file from {id}.log to {stepName}.log if needed
          if (stepsDir && id !== sanitized) {
            const oldPath = path.join(stepsDir, `${id}.log`);
            const newPath = path.join(stepsDir, `${sanitized}.log`);
            try {
              if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
                fs.renameSync(oldPath, newPath);
              }
            } catch {
              /* best-effort */
            }
          }
        }

        // Track the currently in-progress step so the Job-level feed
        // can assign output to the correct per-step log file.
        if (record.state === "inProgress") {
          state.currentInProgressStep.set(timelineId, sanitized);
        }
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ count: existing.length, value: existing }));
  };

  // The runner will hit this depending on the route provided in discovery
  app.patch("/_apis/distributedtask/timelines/:timelineId/records", timelineHandler);
  app.post("/_apis/distributedtask/timelines/:timelineId/records", timelineHandler); // fallback

  // 15b. Timeline GET — runner calls this during FinalizeJob to compute aggregate result.
  // Without it, the runner gets 404 and defaults the job result to Failed.
  app.get("/_apis/distributedtask/timelines/:timelineId", (req: any, res: any) => {
    const timelineId = req.params.timelineId;
    const logDir = state.timelineToLogDir.get(timelineId);
    const filePath = logDir ? path.join(logDir, "timeline.json") : null;

    let records: any[] = [];
    if (filePath) {
      try {
        records = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {
        /* file doesn't exist yet */
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lastChangedBy: "00000000-0000-0000-0000-000000000000",
        lastChangedOn: new Date().toISOString(),
        id: timelineId,
        changeId: 1,
        location: null,
        // includeRecords=True → runner expects a "records" array
        ...(req.query?.includeRecords ? { records } : {}),
      }),
    );
  });

  // 18. Step Outputs Handler — capture outputs sent by the runner
  app.post("/_apis/distributedtask/hubs/:hub/plans/:planId/outputs", (req: any, res) => {
    const planId = req.params.planId;
    const payload = req.body || {};

    // The runner posts step outputs as { stepId: { <name>: { value: <val> } } }
    // Persist to the runner's log directory as outputs.json
    const logDir = state.planToLogDir.get(planId);
    if (logDir && payload && typeof payload === "object") {
      try {
        const outputsPath = path.join(logDir, "outputs.json");
        // Merge with existing outputs
        let existing: Record<string, any> = {};
        try {
          existing = JSON.parse(fs.readFileSync(outputsPath, "utf-8"));
        } catch {
          /* no existing file */
        }

        // Flatten step outputs: { stepId: { name: { value: v } } } → { "stepId.name": v }
        for (const [stepId, outputs] of Object.entries(payload)) {
          if (outputs && typeof outputs === "object") {
            for (const [name, meta] of Object.entries(outputs as Record<string, any>)) {
              const value = meta?.value ?? (typeof meta === "string" ? meta : "");
              existing[`${stepId}.${name}`] = value;
            }
          }
        }

        fs.writeFileSync(outputsPath, JSON.stringify(existing, null, 2));
      } catch {
        /* best-effort */
      }
    }

    res.writeHead(200);
    res.end(JSON.stringify({ value: {} }));
  });

  // 18. Resolve Action Download Info Mock
  app.post(
    "/_apis/distributedtask/hubs/:hub/plans/:planId/actiondownloadinfo",
    async (req: any, res) => {
      const payload = req.body || {};
      const actions = payload.actions || [];
      const result: any = { actions: {} };
      const baseUrl = getBaseUrl(req);

      for (const action of actions) {
        const key = `${action.nameWithOwner}@${action.ref}`;
        // Strip sub-path from nameWithOwner (e.g. "actions/cache/save" → "actions/cache")
        // Sub-path actions share the same repo tarball as the parent action.
        const repoPath = action.nameWithOwner.split("/").slice(0, 2).join("/");
        const [owner, repo] = repoPath.split("/");

        // Point the runner at our local proxy; on cache miss the proxy streams from GitHub
        // while saving to disk — subsequent runs are served instantly from the local cache.
        const localUrl = `${baseUrl}/_dtu/action-tarball/${owner}/${repo}/${action.ref}`;

        result.actions[key] = {
          nameWithOwner: action.nameWithOwner,
          resolvedNameWithOwner: action.nameWithOwner,
          ref: action.ref,
          resolvedSha: crypto
            .createHash("sha1")
            .update(`${action.nameWithOwner}@${action.ref}`)
            .digest("hex"),
          tarballUrl: localUrl,
          zipballUrl: localUrl,
          authentication: null,
        };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    },
  );

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
    // The runner's TaskLog class requires 'path' — null causes ArgumentNullException
    res.end(
      JSON.stringify({
        id: parseInt(logId),
        path: `logs/${logId}`,
        createdOn: new Date().toISOString(),
      }),
    );
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

  // Helper to append filtered lines to the per-step log file
  const writeStepOutputLines = (planId: string, recordId: string, lines: string[]) => {
    const logDir = state.planToLogDir.get(planId);
    if (!logDir) {
      return;
    }

    const RUNNER_INTERNAL_RE =
      /^\[(?:RUNNER|WORKER) \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z (?:INFO|WARN|ERR)\s/;
    let content = "";
    let inGroup = false;

    // Collect agent-ci-output lines for cross-job output passing
    const outputEntries: Array<[string, string]> = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) {
        if (!inGroup) {
          content += "\n";
        }
        continue;
      }
      // Strip BOM + timestamp prefix before filtering
      const stripped = line
        .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
        .replace(/^\uFEFF/, "");

      // Parse agent-ci-output lines: ::agent-ci-output::key=value
      if (stripped.startsWith("::agent-ci-output::")) {
        const kv = stripped.slice("::agent-ci-output::".length);
        const eqIdx = kv.indexOf("=");
        if (eqIdx > 0) {
          outputEntries.push([kv.slice(0, eqIdx), kv.slice(eqIdx + 1)]);
        }
        continue; // Don't include in regular step logs
      }

      if (stripped.startsWith("##[group]")) {
        inGroup = true;
        continue;
      }
      if (stripped.startsWith("##[endgroup]")) {
        inGroup = false;
        continue;
      }

      if (
        inGroup ||
        !stripped ||
        stripped.startsWith("##[") ||
        stripped.startsWith("[command]") ||
        RUNNER_INTERNAL_RE.test(stripped)
      ) {
        continue;
      }
      content += stripped + "\n";
    }

    // Persist captured outputs to outputs.json
    if (outputEntries.length > 0) {
      try {
        const outputsPath = path.join(logDir, "outputs.json");
        let existing: Record<string, string> = {};
        try {
          existing = JSON.parse(fs.readFileSync(outputsPath, "utf-8"));
        } catch {
          /* no existing file */
        }
        for (const [key, value] of outputEntries) {
          existing[key] = value;
        }
        fs.writeFileSync(outputsPath, JSON.stringify(existing, null, 2));
      } catch {
        /* best-effort */
      }
    }

    if (content) {
      try {
        let stepName = state.recordToStepName.get(recordId);
        // Fallback: if the recordId is a Job-level record (no mapping),
        // use the currently in-progress step from the timeline.
        if (!stepName) {
          // Find timelineId for this plan — check all timelines mapped to the same logDir
          const logDirForPlan = state.planToLogDir.get(planId);
          if (logDirForPlan) {
            for (const [tid, tdir] of state.timelineToLogDir) {
              if (tdir === logDirForPlan) {
                const current = state.currentInProgressStep.get(tid);
                if (current) {
                  stepName = current;
                }
                break;
              }
            }
          }
        }
        stepName = stepName || recordId;
        const stepsDir = path.join(logDir, "steps");
        fs.mkdirSync(stepsDir, { recursive: true });
        fs.appendFileSync(path.join(stepsDir, `${stepName}.log`), content);
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
        writeStepOutputLines(planId, req.params.recordId, extractedLines);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, value: [] }));
    },
  );

  // Catch-all: log unhandled requests for debugging
  app.all("(.*)", (req: any, res: any) => {
    console.log(`[DTU] ⚠ Unhandled ${req.method} ${req.url}`);
    if (!res.writableEnded) {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
}
