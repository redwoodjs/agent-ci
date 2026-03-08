import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { state } from "./server/store.js";
import { bootstrapAndReturnApp } from "./server/index.js";
import { getBaseUrl } from "./server/routes/dtu.js";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Polka } from "polka";
import fs from "node:fs";
import path from "node:path";
import { getDtuLogPath } from "./server/logger.js";

let PORT: number;

async function request(method: string, path: string, body?: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: "localhost",
        port: PORT,
        path: path,
        method: method,
        headers: body ? { "Content-Type": "application/json" } : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode || 0,
              body: data ? JSON.parse(data) : null,
            });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );

    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

describe("DTU Server", () => {
  let server: Polka;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.jobs.clear();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server && server.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it("should handle health check", async () => {
    const res = await request("GET", "/");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("online");
  });

  it("should seed a job", async () => {
    const job = { id: 123, name: "test-job" };
    const res = await request("POST", "/_dtu/seed", job);
    expect(res.status).toBe(201);
    expect(res.body.jobId).toBe("123");
    const storedJob = state.jobs.get("123");
    expect(storedJob.id).toBe(job.id);
    expect(storedJob.name).toBe(job.name);
  });

  it("should retrieve a seeded job", async () => {
    await request("POST", "/_dtu/seed", { id: 123, name: "test-job" });
    const res = await request("GET", "/repos/owner/repo/actions/jobs/123");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(123);
  });

  it("should handle missing job", async () => {
    const res = await request("GET", "/repos/owner/repo/actions/jobs/999");
    expect(res.status).toBe(404);
  });

  it("should handle installation lookup", async () => {
    const res = await request("GET", "/repos/owner/repo/installation");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(12345678);
    expect(res.body.access_tokens_url).toContain("/app/installations/12345678/access_tokens");
  });

  it("should handle access token exchange", async () => {
    const res = await request("POST", "/app/installations/12345678/access_tokens");
    expect(res.status).toBe(201);
    expect(res.body.token).toContain("ghs_mock_token_12345678");
  });

  it("should handle registration token generation", async () => {
    const res = await request("POST", "/repos/owner/repo/actions/runners/registration-token");
    expect(res.status).toBe(201);
    expect(res.body.token).toContain("ghr_mock_registration_token");
  });

  it("should handle pipeline service discovery", async () => {
    const res = await request("GET", "/_apis/pipelines");
    expect(res.status).toBe(200);
    expect(res.body.locationServiceData).toBeDefined();
    expect(res.body.locationServiceData.serviceDefinitions).toBeDefined();
  });

  it("should handle global runner registration", async () => {
    const res = await request("POST", "/actions/runner-registration");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(res.body.token_schema).toBe("OAuthAccessToken");
  });

  it("should handle session creation", async () => {
    const res = await request("POST", "/_apis/distributedtask/pools/1/sessions");
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeDefined();
    expect(res.body.agent.name).toBe("machinen-runner");
  });

  it("should handle long polling for messages", async () => {
    // 1. Create a session first
    const sessionRes = await request("POST", "/_apis/distributedtask/pools/1/sessions");
    const sessionId = sessionRes.body.sessionId;

    // 2. Poll for messages (expecting 204 or 200 if job seeded)
    // We'll seed a job first to ensure 200
    await request("POST", "/_dtu/seed", { id: 456, name: "poll-job" });

    const pollRes = await request(
      "GET",
      `/_apis/distributedtask/pools/1/messages?sessionId=${sessionId}`,
    );
    expect(pollRes.status).toBe(200);
    expect(pollRes.body.MessageType).toBe("PipelineAgentJobRequest");
    const body = JSON.parse(pollRes.body.Body);
    expect(body.JobDisplayName).toBe("poll-job");
  });

  it("should log unhandled requests to 404.log", async () => {
    const logDir = path.dirname(getDtuLogPath());
    const logFile = path.join(logDir, "404.log");

    // Clean up any existing 404.log
    if (fs.existsSync(logFile)) {
      fs.unlinkSync(logFile);
    }

    const res = await request("POST", "/some/unhandled/route", { test: "payload" });
    expect(res.status).toBe(404);

    // Give the file writing a tiny bit of time to complete if needed,
    // though appendFileSync is synchronous.
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, "utf-8");

    expect(logContent).toContain("404 Not Found: POST /some/unhandled/route");
    expect(logContent).toContain("Body (parsed JSON)");
    expect(logContent).toContain('"test": "payload"');
  });
});

// ── Artifact v4 upload / download (Twirp + Azure Block Blob protocol) ──────────
describe("Artifact v4 upload/download", () => {
  let server: any;

  beforeAll(async () => {
    state.reset();
    const app = await bootstrapAndReturnApp();
    return new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.server?.address() as import("node:net").AddressInfo;
        PORT = address.port;
        resolve();
      });
    });
  });

  beforeEach(() => {
    state.reset();
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (server?.server) {
        server.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  it("getBaseUrl strips \\r and \\n from Host header (direct unit test)", () => {
    // Node.js's own http client validates headers and won't let us send \r via HTTP.
    // So we test getBaseUrl() directly with a mock request object — this is the
    // exact same path the runner hits when it sends a dirty Host header.
    // Root cause: HTTP/1.1 runners can include a trailing \r in the Host header
    // (part of the \r\n line terminator). If we embed it in the signed URL, the
    // @actions/artifact toolkit triggers "Parse Error: Invalid header value char".
    const mockReq = { headers: { host: `localhost:${PORT}\r`, "x-forwarded-proto": undefined } };
    const url = getBaseUrl(mockReq);

    expect(url).not.toMatch(/[\r\n]/);
    expect(url).toBe(`http://localhost:${PORT}`);

    // Also test \n and mixed whitespace variants
    const mockReq2 = { headers: { host: `  127.0.0.1:8910\r\n  `, "x-forwarded-proto": "http" } };
    const url2 = getBaseUrl(mockReq2);
    expect(url2).not.toMatch(/[\r\n]/);
    expect(url2).toBe("http://127.0.0.1:8910");
  });

  it("full v4 artifact lifecycle: create → block upload → commit → finalize → download", async () => {
    const baseUrl = `http://localhost:${PORT}`;
    const artifactName = "my-v4-artifact";
    const fileContent = Buffer.from("hello from artifact v4!");

    // 1. CreateArtifact (Twirp)
    let res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName, version: 4 }),
      },
    );
    expect(res.status).toBe(200);
    const { signedUploadUrl } = (await res.json()) as { signedUploadUrl: string };
    expect(signedUploadUrl).toMatch(/\/_apis\/artifactblob\//);
    // Crucially, no rogue characters
    expect(signedUploadUrl).not.toMatch(/[\r\n]/);

    // Extract containerId from the URL
    const containerIdMatch = signedUploadUrl.match(/\/artifactblob\/(\d+)\//);
    expect(containerIdMatch).toBeTruthy();
    const _containerId = containerIdMatch![1];

    // 2. Upload a block (Azure Block Blob protocol: PUT ?comp=block&blockid=X)
    const blockId = Buffer.from("block-0001").toString("base64url");
    res = await fetch(`${signedUploadUrl}?comp=block&blockid=${blockId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fileContent,
    });
    expect(res.status).toBe(201);

    // 3. Commit the block list (PUT ?comp=blocklist with XML body)
    const blockListXml = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>`;
    res = await fetch(`${signedUploadUrl}?comp=blocklist`, {
      method: "PUT",
      headers: { "Content-Type": "application/xml" },
      body: blockListXml,
    });
    expect(res.status).toBe(201);

    // 4. FinalizeArtifact (Twirp)
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName }),
      },
    );
    expect(res.status).toBe(200);
    const finalizeBody = (await res.json()) as { ok: boolean; artifactId: string };
    expect(finalizeBody.ok).toBe(true);

    // 5. GetSignedArtifactURL (Twirp)
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/GetSignedArtifactURL`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: artifactName }),
      },
    );
    expect(res.status).toBe(200);
    const { signedUrl } = (await res.json()) as { signedUrl: string };
    expect(signedUrl).toMatch(/\/_apis\/artifactblob\//);
    expect(signedUrl).not.toMatch(/[\r\n]/);

    // 6. Download the blob and verify content roundtrips
    res = await fetch(signedUrl);
    expect(res.status).toBe(200);
    const downloaded = Buffer.from(await res.arrayBuffer());
    expect(downloaded).toEqual(fileContent);
  });

  it("ListArtifacts returns uploaded artifacts", async () => {
    const baseUrl = `http://localhost:${PORT}`;

    // Create + finalize an artifact
    let res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-test-artifact", version: 4 }),
      },
    );
    const { signedUploadUrl } = (await res.json()) as { signedUploadUrl: string };

    // Single-block (no comp param) upload
    await fetch(signedUploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: Buffer.from("data"),
    });

    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "list-test-artifact" }),
      },
    );
    expect(res.status).toBe(200);

    // ListArtifacts with name filter
    res = await fetch(
      `${baseUrl}/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nameFilter: "list-test-artifact" }),
      },
    );
    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: any[] };
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].name).toBe("list-test-artifact");
  });

  it("should handle job request renewal on bare path (actual runner behavior)", async () => {
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests", {
      requestId: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.lockedUntil).toBeDefined();
    expect(new Date(res.body.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("should handle job request renewal on parameterized path", async () => {
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests/1", {
      requestId: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body.lockedUntil).toBeDefined();
    expect(new Date(res.body.lockedUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("should handle job request finish (PATCH with result + finishTime)", async () => {
    const finishTime = new Date().toISOString();
    const res = await request("PATCH", "/_apis/distributedtask/jobrequests", {
      requestId: 1,
      result: "succeeded",
      finishTime,
    });
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("succeeded");
    expect(res.body.finishTime).toBe(finishTime);
    // Finish requests should NOT get lockedUntil injected
    expect(res.body.lockedUntil).toBeUndefined();
  });
});
