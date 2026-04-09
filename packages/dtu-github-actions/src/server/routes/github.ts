import { execSync } from "node:child_process";
import { Polka } from "polka";
import { state } from "../store.js";
import { getBaseUrl } from "./dtu.js";

const EMPTY_TARBALL = execSync("tar czf - -T /dev/null");

export function registerGithubRoutes(app: Polka) {
  // 2. GitHub REST API Mirror - Job Detail
  app.get("/repos/:owner/:repo/actions/jobs/:id", (req: any, res) => {
    const jobId = req.params.id;
    const job = state.jobs.get(jobId);

    if (job) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(job));
    } else {
      console.warn(`[DTU] Job not found: ${jobId}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found (DTU Mock)" }));
    }
  });

  // 3. GitHub App Token Exchange Mock (App Level)
  app.post("/app/installations/:id/access_tokens", (req: any, res) => {
    const installationId = req.params.id;

    console.log(`[DTU] Token exchange for installation: ${installationId}`);

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
  });

  // 4. GitHub Installation Lookup Mock (Repo Level)
  app.get("/repos/:owner/:repo/installation", (req: any, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    console.log(`[DTU] Fetching installation for ${owner}/${repo}`);

    const baseUrl = getBaseUrl(req);

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
  });

  // 5. GitHub Runner Registration Token Mock
  // Supports both v3 and bare api calls through polling
  app.post("/repos/:owner/:repo/actions/runners/registration-token", (req: any, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    console.log(`[DTU] Generating registration token for ${owner}/${repo}`);

    const response = {
      token: `ghr_mock_registration_token_${Math.random().toString(36).substring(7)}`,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  app.post("/api/v3/repos/:owner/:repo/actions/runners/registration-token", (req: any, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    console.log(`[DTU] Generating registration token for ${owner}/${repo} (v3)`);

    const response = {
      token: `ghr_mock_registration_token_${Math.random().toString(36).substring(7)}`,
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    };

    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  });

  // 6. Global Runner Registration Mock (Discovery/Handshake)
  const globalRunnerRegistrationHandler = (req: any, res: any) => {
    console.log(`[DTU] Handling global runner registration (${req.url})`);
    const token = `ghr_mock_tenant_token_${Math.random().toString(36).substring(7)}`;
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

    const baseUrl = getBaseUrl(req);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        token: token,
        token_schema: "OAuthAccessToken",
        authorization_url: `${baseUrl}/auth/authorize`,
        client_id: "mock-client-id",
        tenant_id: "mock-tenant-id",
        expiration: expiresAt,
        url: baseUrl,
      }),
    );
  };

  app.post("/actions/runner-registration", globalRunnerRegistrationHandler);
  app.post("/api/v3/actions/runner-registration", globalRunnerRegistrationHandler);

  // 7. Compare commits — used by actions that detect changed files (e.g. Khan/actions@get-changed-files).
  // Runs `git diff` on the original repo root and returns a GitHub-compatible response.
  const compareHandler = (req: any, res: any) => {
    const basehead: string = req.params.basehead;
    // GitHub format: "base...head" (three dots) or "base..head" (two dots)
    const parts = basehead.split(/\.{2,3}/);
    const [base, head] = parts;

    if (!base || !head) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Invalid basehead format" }));
      return;
    }

    const repoRoot = state.repoRoot;
    if (!repoRoot) {
      // No repo root available — return empty comparison
      console.warn("[DTU] Compare: no repoRoot available, returning empty file list");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "identical", files: [], total_commits: 0, commits: [] }));
      return;
    }

    try {
      const output = execSync(`git diff --name-status ${base} ${head}`, {
        cwd: repoRoot,
        stdio: "pipe",
        timeout: 10000,
      }).toString();

      const statusMap: Record<string, string> = {
        A: "added",
        M: "modified",
        D: "removed",
        R: "renamed",
        C: "copied",
        T: "changed",
      };

      const files = output
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => {
          // Format: "M\tfilename" or "R100\told\tnew"
          const parts = line.split("\t");
          const rawStatus = parts[0]!;
          const statusChar = rawStatus[0]!;
          const filename = rawStatus.startsWith("R") ? parts[2]! : parts[1]!;
          const previousFilename = rawStatus.startsWith("R") ? parts[1] : undefined;
          return {
            sha: "0000000000000000000000000000000000000000",
            filename,
            status: statusMap[statusChar] || "modified",
            ...(previousFilename ? { previous_filename: previousFilename } : {}),
            additions: 0,
            deletions: 0,
            changes: 0,
          };
        });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: files.length > 0 ? "ahead" : "identical",
          total_commits: 1,
          commits: [],
          files,
        }),
      );
    } catch (err: any) {
      console.warn(`[DTU] Compare failed (${base}...${head}):`, err.message);
      // Fall back to listing all tracked files as "added"
      try {
        const allFiles = execSync("git ls-files", {
          cwd: repoRoot,
          stdio: "pipe",
          timeout: 10000,
        }).toString();

        const files = allFiles
          .trim()
          .split("\n")
          .filter((f) => f.length > 0)
          .map((filename) => ({
            sha: "0000000000000000000000000000000000000000",
            filename,
            status: "added",
            additions: 0,
            deletions: 0,
            changes: 0,
          }));

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ahead",
            total_commits: 1,
            commits: [],
            files,
          }),
        );
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "Failed to compute diff" }));
      }
    }
  };
  app.get("/repos/:owner/:repo/compare/:basehead", compareHandler);
  app.get("/_apis/repos/:owner/:repo/compare/:basehead", compareHandler);

  // 8. List pull requests associated with a commit — used by some changed-files actions
  // when the push event has an all-zeros `before` (new branch push).
  const listPrsForCommitHandler = (req: any, res: any) => {
    console.log(`[DTU] List PRs for commit ${req.params.sha} (mock: returning empty)`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([]));
  };
  app.get("/repos/:owner/:repo/commits/:sha/pulls", listPrsForCommitHandler);
  app.get("/_apis/repos/:owner/:repo/commits/:sha/pulls", listPrsForCommitHandler);

  // 9. Tarball route — actions/checkout downloads repos via this endpoint.
  // Return an empty tar.gz since the workspace is already bind-mounted.
  const tarballHandler = (req: any, res: any) => {
    console.log(`[DTU] Serving empty tarball for ${req.url}`);
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Length": String(EMPTY_TARBALL.length),
    });
    res.end(EMPTY_TARBALL);
  };
  app.get("/repos/:owner/:repo/tarball/:ref", tarballHandler);
  app.get("/_apis/repos/:owner/:repo/tarball/:ref", tarballHandler);
}
