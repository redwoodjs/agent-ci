import http from "node:http";
import crypto from "node:crypto";
import { execa } from "execa";
import { config } from "./config.js";
import {
  PipelineAgentJobRequest,
  JobStep,
  JobVariable,
  ContextData,
  MessageResponse,
} from "./types.js";

// Kill existing process on port 8910
try {
  await execa("kill", ["-9", "$(lsof -t -i:8910)"], { shell: true, reject: false });
} catch {
  // Ignore error if no process found
}

/**
 * Digital Twin Universe (DTU) - GitHub API Mock Server
 *
 * This server mirrors the GitHub REST API for Actions.
 * It maintains an in-memory store of job metadata seeded by simulation scripts.
 */

export const jobs = new Map<string, any>();
export const sessions = new Map<string, any>();
export const messageQueues = new Map<string, any[]>();
export const pendingPolls = new Map<string, { res: http.ServerResponse; baseUrl: string }>();
export const timelines = new Map<string, any[]>();
export const logs = new Map<string, string[]>();

// Clear state on start
jobs.clear();
sessions.clear();
messageQueues.clear();
pendingPolls.clear();
timelines.clear();
logs.clear();

// Helper to convert JS objects to ContextData
function toContextData(obj: any): {
  t: number;
  a?: any[];
  d?: any[];
  s?: string;
  b?: boolean;
  n?: number;
  v?: any;
} {
  if (typeof obj === "string") return { t: 0, s: obj };
  if (typeof obj === "boolean") return { t: 3, b: obj };
  if (typeof obj === "number") return { t: 4, n: obj };

  if (Array.isArray(obj)) {
    return {
      t: 1,
      a: obj.map(toContextData),
    };
  }

  if (typeof obj === "object" && obj !== null) {
    return {
      t: 2,
      d: Object.entries(obj).map(([k, v]) => ({ k, v: toContextData(v) })),
    };
  }

  return { t: 0, s: "" };
}

function createJobResponse(jobId: string, payload: any, baseUrl: string): MessageResponse {
  const mappedSteps: JobStep[] = (payload.steps || []).map((step: any) => ({
    ...step,
    Id: crypto.randomUUID(),
  }));

  const repoFullName = payload.repository?.full_name || "redwoodjs/opposite-actions";
  const ownerName = payload.repository?.owner?.login || "redwoodjs";

  const Variables: { [key: string]: JobVariable } = {
    "system.github.token": { Value: "fake-token", IsSecret: true },
    "system.github.job": { Value: "local-job", IsSecret: false },
    "system.github.repository": { Value: repoFullName, IsSecret: false },
    "github.repository": { Value: repoFullName, IsSecret: false },
    "github.actor": { Value: ownerName, IsSecret: false },
    "github.sha": {
      Value: payload.headSha || "0000000000000000000000000000000000000000",
      IsSecret: false,
    },
    "github.ref": { Value: "refs/heads/main", IsSecret: false },
    repository: { Value: repoFullName, IsSecret: false },
    GITHUB_REPOSITORY: { Value: repoFullName, IsSecret: false },
    GITHUB_ACTOR: { Value: ownerName, IsSecret: false },
    "build.repository.name": { Value: repoFullName, IsSecret: false },
    "build.repository.uri": { Value: `https://github.com/${repoFullName}`, IsSecret: false },
  };

  // ... ContextData ...

  const githubContext = {
    repository: repoFullName,
    event: {
      repository: {
        full_name: repoFullName,
        name: payload.repository?.name || "opposite-actions",
        owner: { login: ownerName },
      },
      pull_request: null,
    },
    actor: ownerName,
    sha: "0000000000000000000000000000000000000000",
    ref: "refs/heads/main",
    server_url: baseUrl,
    api_url: `${baseUrl}/_apis`,
    graphql_url: `${baseUrl}/_graphql`,
    workspace: "/home/runner/work/opposite-actions/opposite-actions",
    action: "__run",
    token: "fake-token",
    job: "local-job",
  };

  const ContextData: ContextData = {
    github: toContextData(githubContext) as any,
  };

  const jobRequest: PipelineAgentJobRequest = {
    MessageType: "PipelineAgentJobRequest",
    Plan: {
      PlanId: crypto.randomUUID(),
      PlanType: "Action",
      ScopeId: crypto.randomUUID(),
    },
    Timeline: {
      Id: crypto.randomUUID(),
      ChangeId: 1,
    },
    JobId: crypto.randomUUID(),
    RequestId: parseInt(jobId) || 1,
    JobDisplayName: payload.name || "local-job",
    JobName: payload.name || "local-job",
    Steps: mappedSteps,
    Variables: Variables,
    ContextData: ContextData,
    Resources: {
      Repositories: [
        {
          Alias: "self",
          Id: "repo-1",
          Type: "git",
          Version: payload.headSha || "HEAD",
          Url: `https://github.com/${repoFullName}`,
          Properties: {
            id: "repo-1",
            name: payload.repository?.name || "opposite-actions",
            fullName: repoFullName, // Required by types
            repoFullName: repoFullName, // camelCase
            owner: ownerName,
            defaultBranch: payload.repository?.default_branch || "main",
            cloneUrl: `https://github.com/${repoFullName}.git`,
          },
        },
      ],
      Endpoints: [
        {
          Name: "SystemVssConnection",
          Url: baseUrl,
          Authorization: {
            Parameters: {
              AccessToken:
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmNoaWQiOiIxMjMifQ.c2lnbmF0dXJl",
            },
            Scheme: "OAuth",
          },
        },
      ],
    },
    Workspace: {
      Path: "/home/runner/work/opposite-actions/opposite-actions",
    },
    SystemVssConnection: {
      Url: baseUrl,
      Authorization: {
        Parameters: {
          AccessToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmNoaWQiOiIxMjMifQ.c2lnbmF0dXJl",
        },
        Scheme: "OAuth",
      },
    },
    Actions: [],
    MaskHints: [],
    EnvironmentVariables: [],
  };

  console.log(`[DTU] DEBUG: Generating Job Response for JobId: ${crypto.randomUUID()}`);
  console.log(
    `[DTU] DEBUG: repoFullName in Resources: ${jobRequest.Resources.Repositories[0].Properties["repoFullName"]}`,
  );
  console.log(`[DTU] DEBUG: ContextData Payload:`, JSON.stringify(jobRequest.ContextData, null, 2));

  return {
    MessageId: 1,
    MessageType: "PipelineAgentJobRequest",
    Body: JSON.stringify(jobRequest),
  };
}

export const server = http.createServer((req, res) => {
  const { method, headers } = req;
  let { url } = req;

  if (!url) {
    res.statusCode = 400;
    res.end("Missing URL");
    return;
  }

  // Handle absolute URIs (proxy requests)
  if (url.startsWith("http")) {
    const parsedUrl = new URL(url);
    url = parsedUrl.pathname + parsedUrl.search;
  }

  let host = headers.host || `localhost:${config.DTU_PORT}`;
  const protocol = headers["x-forwarded-proto"] || "http";

  // If host doesn't have a port, append it
  if (!host.includes(":")) {
    host = `${host}:${config.DTU_PORT}`;
  }

  const baseUrl = `${protocol}://${host}`;

  console.log(`[DTU] ${method} ${url} (Host: ${host})`);
  console.log(`[DTU] Headers:`, JSON.stringify(headers, null, 2));
  console.log(`[DTU] Constructed BaseURL: ${baseUrl}`);

  // 1. Internal Seeding Endpoint
  if (method === "POST" && url === "/_dtu/seed") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const jobId = payload.id?.toString();
        if (jobId) {
          const mappedSteps = (payload.steps || []).map((step: any) => ({
            ...step,
            Id: crypto.randomUUID(), // Always use a UUID for Step ID
          }));

          jobs.set(jobId, { ...payload, steps: mappedSteps });
          console.log(`[DTU] Seeded job: ${jobId}`);
          console.log(
            `[DTU] Seed Payload Repository:`,
            JSON.stringify(payload.repository, null, 2),
          );

          // Notify any pending polls
          for (const [sessionId, { res, baseUrl: runnerBaseUrl }] of pendingPolls) {
            console.log(
              `[DTU] Notifying session ${sessionId} of new job ${jobId} (Wait URL: ${runnerBaseUrl})`,
            );
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(createJobResponse(jobId, payload, runnerBaseUrl)));
            pendingPolls.delete(sessionId);
          }

          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", jobId }));
        } else {
          res.writeHead(400);
          res.end("Missing job ID");
        }
      } catch {
        res.writeHead(400);
        res.end("Invalid JSON");
      }
    });
    return;
  }

  // 2. GitHub REST API Mirror
  const jobMatch = url?.match(/\/repos\/[^/]+\/[^/]+\/actions\/jobs\/(\d+)/);
  if (method === "GET" && jobMatch) {
    const jobId = jobMatch[1];
    const job = jobs.get(jobId);
    if (job) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(job));
    } else {
      console.warn(`[DTU] Job not found: ${jobId}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found (DTU Mock)" }));
    }
    return;
  }

  // 3. GitHub App Token Exchange Mock (App Level)
  const tokenMatch = url?.match(/\/app\/installations\/(\d+)\/access_tokens/);
  if (method === "POST" && tokenMatch) {
    const installationId = tokenMatch[1];
    const authHeader = req.headers["authorization"];
    console.log(`[DTU] Token exchange for installation: ${installationId}`);
    if (authHeader) {
      console.log(`[DTU] Received JWT: ${authHeader.substring(0, 20)}...`);
    }

    // Return a mock installation token
    const response = {
      token: `ghs_mock_token_${installationId}_${Math.random().toString(36).substring(7)}`,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      permissions: {
        actions: "read",
        metadata: "read",
      },
      repository_selection: "selected",
    };

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // 4. GitHub Installation Lookup Mock (Repo Level)
  const repoInstallationMatch = url?.match(/\/repos\/([^/]+)\/([^/]+)\/installation/);
  if (method === "GET" && repoInstallationMatch) {
    const owner = repoInstallationMatch[1];
    const repo = repoInstallationMatch[2];
    console.log(`[DTU] Fetching installation for ${owner}/${repo}`);

    const response = {
      id: 12345678,
      account: {
        login: owner,
        type: "User",
      },
      repository_selection: "all",
      access_tokens_url: `${baseUrl}/app/installations/12345678/access_tokens`,
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // 5. GitHub Runner Registration Token Mock
  const registrationTokenMatch = url?.match(
    /(?:\/api\/v3)?\/repos\/([^/]+)\/([^/]+)\/actions\/runners\/registration-token/,
  );
  if (method === "POST" && registrationTokenMatch) {
    const owner = registrationTokenMatch[1];
    const repo = registrationTokenMatch[2];
    console.log(`[DTU] Generating registration token for ${owner}/${repo}`);

    const response = {
      token: `ghr_mock_registration_token_${Math.random().toString(36).substring(7)}`,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
    return;
  }

  // 6. Global Runner Registration Mock (Discovery/Handshake)
  if (
    method === "POST" &&
    (url === "/actions/runner-registration" || url === "/api/v3/actions/runner-registration")
  ) {
    console.log(`[DTU] Handling global runner registration: ${url}`);
    const token = `ghr_mock_tenant_token_${Math.random().toString(36).substring(7)}`;
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        token: token,
        token_schema: "OAuthAccessToken",
        authorization_url: `${baseUrl}/auth/authorize`,
        client_id: "mock-client-id",
        tenant_id: "mock-tenant-id",
        expiration: expiresAt,
        url: baseUrl, // Attempt to populate TenantUrl as well if needed
      }),
    );
    return;
  }

  // 12. Sessions Handler (Mock)
  if (url?.includes("/sessions")) {
    const sessionMatch = url?.match(/\/distributedtask\/pools\/(\d+)\/sessions(?:\/([^/?]+))?/);
    if (sessionMatch) {
      const poolId = sessionMatch[1];
      const sessionId = sessionMatch[2];

      if (method === "POST" && !sessionId) {
        console.log(`[DTU] Creating session for pool ${poolId}`);
        const newSessionId = crypto.randomUUID();
        const response = {
          sessionId: newSessionId,
          ownerName: "oa-runner",
          agent: {
            id: 1,
            name: "oa-runner",
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

        sessions.set(newSessionId, response);
        messageQueues.set(newSessionId, []);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
        return;
      }

      if (method === "DELETE" && sessionId) {
        console.log(`[DTU] Deleting session ${sessionId} for pool ${poolId}`);
        res.writeHead(204);
        res.end();
        return;
      }
    }
  }

  // 13. Messages Handler (Mock) - Long Polling
  if (url?.includes("/messages")) {
    const urlParts = new URL(url, baseUrl);
    const sessionId = urlParts.searchParams.get("sessionId");

    if (method === "GET") {
      const lastMessageId = urlParts.searchParams.get("lastMessageId");
      console.log(
        `[DTU] Polling messages for session ${sessionId} (lastMessageId: ${lastMessageId})`,
      );

      if (!sessionId || !sessions.has(sessionId)) {
        res.writeHead(404);
        res.end("Session not found");
        return;
      }

      // If there's already a pending poll for this session, close it
      const existing = pendingPolls.get(sessionId);
      if (existing) {
        existing.res.writeHead(204);
        existing.res.end();
      }
      pendingPolls.set(sessionId, { res, baseUrl });

      console.log(
        `[DTU] TRACE-DELIVERY: Entering poll handler for session ${sessionId}. jobs.size=${jobs.size}`,
      );
      if (jobs.size > 0) {
        const [[jobId, jobData]] = Array.from(jobs.entries());
        console.log(
          `[DTU] TRACE-DELIVERY: Job found. Sending immediate job ${jobId} to session ${sessionId}`,
        );
        try {
          const response = createJobResponse(jobId, jobData, baseUrl);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
          jobs.delete(jobId);
          pendingPolls.delete(sessionId);
          return;
        } catch (e) {
          console.error(`[DTU] Error creating job response:`, e);
          // Don't delete job, let it retry? Or delete to avoid loop?
          // Better to not delete so we can debug, but might infinite loop.
          // For now, allow retry.
          res.writeHead(500);
          res.end("Internal Server Error generating job");
          return;
        }
      }

      // Long poll: Wait up to 20 seconds before returning empty
      const timeout = setTimeout(() => {
        const pending = pendingPolls.get(sessionId);
        if (pending && pending.res === res) {
          pendingPolls.delete(sessionId);
          if (!res.writableEnded) {
            // Returning 204 No Content for timeout is often better for mocks
            res.writeHead(204);
            res.end();
          }
        }
      }, 20000);

      res.on("close", () => {
        clearTimeout(timeout);
        const pending = pendingPolls.get(sessionId);
        if (pending && pending.res === res) {
          pendingPolls.delete(sessionId);
        }
      });
      return;
    }

    if (method === "DELETE") {
      const messageId = urlParts.searchParams.get("messageId");
      console.log(`[DTU] Acknowledging/Deleting message ${messageId} for session ${sessionId}`);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // 7. Pipeline Service Discovery Mock
  if (
    method === "GET" &&
    (url?.includes("/_apis/pipelines") || url?.includes("/_apis/connectionData"))
  ) {
    console.log(`[DTU] Handling service discovery: ${url}`);
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
            {
              moniker: "PublicAccessMapping",
              displayName: "Public Access",
              accessPoint: baseUrl,
            },
          ],
          serviceDefinitions: [
            {
              serviceType: "distributedtask",
              identifier: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              displayName: "distributedtask",
              relativeToSetting: 3, // FullyQualified
              relativePath: "",
              description: "Distributed Task Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              locationMappings: [
                {
                  accessMappingMoniker: "PublicAccessMapping",
                  location: baseUrl,
                },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "A8C47E17-4D56-4A56-92BB-DE7EA7DC65BE", // Pools
              displayName: "Pools",
              relativeToSetting: 3, // FullyQualified
              relativePath: "/_apis/distributedtask/pools",
              description: "Pools Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
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
              relativeToSetting: 3, // FullyQualified
              relativePath:
                "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/actiondownloadinfo",
              description: "Action Download Info Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              locationMappings: [
                {
                  accessMappingMoniker: "PublicAccessMapping",
                  location: `${baseUrl}`,
                },
              ],
            },
            {
              serviceType: "distributedtask",
              identifier: "858983e4-19bd-4c5e-864c-507b59b58b12", // AppendTimelineRecordFeedAsync
              displayName: "AppendTimelineRecordFeed",
              relativeToSetting: 3, // FullyQualified
              relativePath:
                "/_apis/distributedtask/hubs/{hubName}/plans/{planId}/timelines/{timelineId}/records/{recordId}/feed",
              description: "Timeline Feed Service",
              serviceOwner: "A85B8835-C1A1-4AAC-AE97-1C3D0BA72DBD",
              locationMappings: [
                {
                  accessMappingMoniker: "PublicAccessMapping",
                  location: `${baseUrl}`,
                },
              ],
            },
          ],
        },
      }),
    );
    return;
  }

  // 19. Append Timeline Record Feed Mock
  if (method === "POST" && url?.includes("/feed")) {
    // console.log(`[DTU] Append timeline record feed: ${url}`);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // Just acknowledge
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, value: [] }));
    });
    return;
  }

  // 10. Pools Handler (Mock)
  if (
    method === "GET" &&
    url?.includes("/_apis/distributedtask/pools") &&
    !url?.includes("/agents")
  ) {
    console.log(`[DTU] Handling pools request: ${url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        count: 1,
        value: [
          {
            id: 1,
            name: "Default",
            isHosted: false,
            autoProvision: true,
          },
        ],
      }),
    );
    return;
  }

  // 11. Agents Handler (Mock)
  // GET: Check if agent exists
  if (
    method === "GET" &&
    url?.includes("/_apis/distributedtask/pools") &&
    url?.includes("/agents")
  ) {
    console.log(`[DTU] Handling get agents request: ${url}`);
    const _agentName = new URLSearchParams(url.split("?")[1]).get("agentName");

    // If querying by name, return empty list to simulate "not found" so runner registers
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        count: 0,
        value: [],
      }),
    );
    return;
  }

  // POST: Register new agent
  if (
    method === "POST" &&
    url?.includes("/_apis/distributedtask/pools") &&
    url?.includes("/agents")
  ) {
    console.log(`[DTU] Handling register agent request: ${url}`);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const payload = JSON.parse(body);
      const agentId = Math.floor(Math.random() * 10000);

      const response = {
        id: agentId,
        name: payload.name,
        version: payload.version,
        osDescription: payload.osDescription,
        ephemeral: payload.ephemeral,
        disableUpdate: payload.disableUpdate,
        enabled: true,
        status: "online",
        provisioningState: "Provisioned",
        authorization: {
          clientId: crypto.randomUUID(),
          authorizationUrl: `${baseUrl}/auth/authorize`,
        },
        accessPoint: `${baseUrl}/_apis/distributedtask/pools/${payload.poolId}/agents/${agentId}`,
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
    return;
  }

  // 14. Job Request Update / Renewal Mock
  if (method === "PATCH" && url?.includes("/_apis/distributedtask/jobrequests")) {
    console.log(`[DTU] Handling job request update/renewal: ${url}`);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        // Update LockedUntil to keep the runner happy
        if (!payload.lockedUntil) {
          // If it's just a query param lock renewal, we might need to construct a response.
          // But usually the runner sends the job request object.
        }
        // Always return a valid future date for lock
        payload.lockedUntil = new Date(Date.now() + 60000).toISOString();

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (e) {
        console.error("[DTU] Error parsing job request update body", e);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ lockedUntil: new Date(Date.now() + 60000).toISOString() }));
      }
    });
    return;
  }

  // 15. Timeline Records Handler (Status Updates & Log Links)
  if (
    method === "PATCH" &&
    url?.includes("/_apis/distributedtask/timelines/") &&
    url?.includes("/records")
  ) {
    console.log(`[DTU] Handling timeline records update: ${url}`);
    const timelineId = url.split("/timelines/")[1].split("/")[0];

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const newRecords = payload.value || [];

        let existing = timelines.get(timelineId) || [];

        // Merge records
        for (const record of newRecords) {
          const idx = existing.findIndex((r) => r.id === record.id);
          if (idx >= 0) {
            existing[idx] = { ...existing[idx], ...record };
          } else {
            existing.push(record);
          }
        }

        timelines.set(timelineId, existing);
        console.log(`[DTU] Updated timeline ${timelineId} with ${newRecords.length} records`);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: existing.length, value: existing }));
      } catch (e) {
        console.error("[DTU] Error parsing timeline body", e);
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // 16. Log Creation Handler
  if (
    method === "POST" &&
    url?.includes("/_apis/distributedtask/") &&
    url?.includes("/logs") &&
    !url?.includes("/lines")
  ) {
    console.log(`[DTU] Creating log: ${url}`);
    let logId = "";
    const match = url.match(/\/logs\/([^/?]+)/);
    if (match) logId = match[1];

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      // Ensure map entry exists
      if (!logs.has(logId)) logs.set(logId, []);

      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: logId, state: "Created" })); // Mock response
    });
    return;
  }

  // 17. Log Line Appending Handler
  if (method === "POST" && url?.includes("/_apis/distributedtask/") && url?.includes("/lines")) {
    // console.log(`[DTU] Appending log lines: ${url}`);
    let logId = "";
    const match = url.match(/\/logs\/([^/?]+)/);
    if (match) logId = match[1];

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const lines = (payload.value || []).map((l: any) => l.message || l); // Handle object or string lines

        const existing = logs.get(logId) || [];
        existing.push(...lines);
        logs.set(logId, existing);

        // Console log for visibility in pnpm dev
        lines.forEach((l: string) => console.log(`[Log-${logId.substring(0, 4)}] ${l}`));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ count: existing.length, value: existing }));
      } catch (e) {
        console.error("[DTU] Error appending logs", e);
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // Debug: Dump State
  if (method === "GET" && url === "/_dtu/dump") {
    const dump = {
      jobs: Object.fromEntries(jobs),
      timelines: Object.fromEntries(timelines),
      logs: Object.fromEntries(logs),
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(dump));
    return;
  }

  // 18. Resolve Action Download Info Mock
  if (method === "POST" && url?.includes("/actiondownloadinfo")) {
    console.log(`[DTU] resolving action download info: ${url}`);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const actions = payload.actions || [];
        const result: any = { actions: {} };

        for (const action of actions) {
          const key = `${action.nameWithOwner}@${action.ref}`;
          // Construct a public GitHub URL for the action
          // e.g. https://api.github.com/repos/actions/checkout/tarball/v4
          // or https://codeload.github.com/actions/checkout/legacy.tar.gz/refs/tags/v4 ?
          // The runner seems to support standard GitHub API tarball URLs.
          // We'll use the API URL format which redirects to codeload.
          const downloadUrl = `https://api.github.com/repos/${action.nameWithOwner}/tarball/${action.ref}`;

          result.actions[key] = {
            nameWithOwner: action.nameWithOwner,
            resolvedNameWithOwner: action.nameWithOwner,
            ref: action.ref,
            resolvedSha: "fake-sha",
            tarballUrl: downloadUrl,
            zipballUrl: downloadUrl.replace("tarball", "zipball"),
            authentication: null, // No token for public actions
          };
        }

        console.log(`[DTU] Resolved ${actions.length} actions.`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error("[DTU] Error resolving actions", e);
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // 8. Global OPTIONS Handler (for CORS/Capabilities + Resource Discovery)
  if (method === "OPTIONS") {
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-TFS-FedAuthRedirect, X-VSS-E2EID, X-TFS-Session",
      "Content-Type": "application/json",
    });

    // Return the list of available API resources
    // This allows VssHttpClientBase to discover the "Pools" resource
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

    res.end(
      JSON.stringify({
        count: responseValue.length,
        value: responseValue,
      }),
    );
    return;
  }

  // 9. Generic API Root Handler (to prevent 404s on discovery)
  if (method === "GET" && url?.startsWith("/_apis")) {
    console.log(`[DTU] Catch-all for _apis: ${url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ value: [] }));
    return;
  }

  // health check
  if ((method === "GET" || method === "HEAD") && url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      method === "GET" ? JSON.stringify({ status: "online", seededJobs: jobs.size }) : undefined,
    );
    return;
  }

  // 16. Fallback (404)
  // Log unhandled requests to see if we satisfy all runner demands
  console.log(`[DTU] 404 Not Found: ${req.method} ${url}`);
  console.log(`[DTU] Unhandled Headers:`, JSON.stringify(req.headers, null, 2));

  res.writeHead(404);
  res.end("Not Found (DTU Mock)");
});

if (import.meta.url === `file://${process.argv[1]}` || process.env.NODE_ENV !== "test") {
  server.listen(config.DTU_PORT, "0.0.0.0", () => {
    console.log(
      `[DTU] OA-RUN-1 Mock GitHub API server running at http://0.0.0.0:${config.DTU_PORT}`,
    );
  });
}
