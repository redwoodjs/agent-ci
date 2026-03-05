import polka from "polka";
import cors from "cors";
import bodyParser from "body-parser";
import {
  getRecentRepos,
  addRecentRepo,
  removeRecentRepo,
  getWatchedRepos,
  enableWatchMode,
  disableWatchMode,
  getWorkflows,
  getWorkflowEnabledMap,
  setWorkflowEnabled,
  runWorkflow,
  stopWorkflow,
  retryRun,
  addSSEClient,
  loadWatchedRepos,
  getDtuStatus,
  startDtu,
  stopDtu,
  getRunsForCommit,
  getRecentRuns,
  getRunDetail,
  getRunLogs,
  getRunErrors,
  getRunTimeline,
  getMaxConcurrentJobs,
  setMaxConcurrentJobs,
} from "./orchestrator.js";
import { getBranches, getGitCommits, getWorkingTreeStatus } from "./git.js";

import { getWorkingDirectory } from "../logger.js";
import {
  pruneStaleWorkspaces,
  killAllRunnerContainers,
  pruneOrphanedDockerResources,
} from "../shutdown.js";

const PORT = 8912;
export const app = polka();

app.use(cors());
app.use(bodyParser.json());

// Repos
app.get("/repos", async (req, res) => {
  const repos = await getRecentRepos();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(repos));
});

app.post("/repos", async (req, res) => {
  const { repoPath } = (req as any).body || {};
  if (repoPath) {
    await addRecentRepo(repoPath);
  }
  res.writeHead(200).end();
});

app.delete("/repos", async (req, res) => {
  const { repoPath } = (req as any).body || {};
  if (repoPath) {
    await removeRecentRepo(repoPath);
  }
  res.writeHead(200).end();
});

// UI Navigation State (in-memory, shared across all views)
let uiState: Record<string, string> = {};

app.get("/ui-state", (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(uiState));
});

app.post("/ui-state", (req, res) => {
  const body = (req as any).body || {};
  uiState = { ...uiState, ...body };
  res.writeHead(200).end();
});

// Watched Repos
app.get("/repos/watched", async (req, res) => {
  const repos = await getWatchedRepos();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(repos));
});

app.post("/repos/watched", async (req, res) => {
  const { repoPath } = (req as any).body || {};
  if (repoPath) {
    await enableWatchMode(repoPath);
  }
  res.writeHead(200).end();
});

app.delete("/repos/watched", async (req, res) => {
  const { repoPath } = (req as any).body || {};
  if (repoPath) {
    await disableWatchMode(repoPath);
  }
  res.writeHead(200).end();
});

// Status & Events
app.get("/status", async (req, res) => {
  // Derive real status from recent runs
  let status = "Idle";
  try {
    const recent = await getRecentRuns(5);
    if (recent.some((r) => r.status === "Running")) {
      status = "Running";
    } else if (recent.length > 0) {
      const latest = recent[0];
      if (latest.status === "Failed") {
        status = "Failed";
      } else if (latest.status === "Passed") {
        status = "Passed";
      }
    }
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status, activeContainers: [], recentJobs: [] }));
});

app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
  addSSEClient(res);
});

// Workflows
app.get("/workflows", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) {
    return res.writeHead(400).end();
  }
  const workflows = await getWorkflows(repoPath);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(workflows));
});

app.get("/workflows/warm-status", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) {
    return res.writeHead(400).end();
  }
  try {
    const { execSync } = await import("node:child_process");
    const { isWarmNodeModules, computeLockfileHash } = await import("../cleanup.js");
    const { getWorkingDirectory } = await import("../logger.js");
    const path = await import("node:path");

    // Derive repoSlug from git remote (matching runner.ts and local-job.ts)
    let repoSlug = repoPath.replace(/.*\//, "").replace("/", "-");
    try {
      const remoteUrl = execSync("git remote get-url origin", { cwd: repoPath, stdio: "pipe" })
        .toString()
        .trim();
      const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
      if (match) {
        repoSlug = match[1].replace("/", "-");
      }
    } catch {}

    let lockfileHash = "no-lockfile";
    try {
      lockfileHash = computeLockfileHash(repoPath);
    } catch {}

    const warmModulesDir = path.join(getWorkingDirectory(), "warm-modules", repoSlug, lockfileHash);
    const warm = isWarmNodeModules(warmModulesDir);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ warm, lockfileHash }));
  } catch {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ warm: false, lockfileHash: "unknown" }));
  }
});

app.get("/workflows/enabled", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) {
    return res.writeHead(400).end();
  }
  const workflows = await getWorkflows(repoPath);
  const enabledMap = await getWorkflowEnabledMap(repoPath, workflows);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(enabledMap));
});

app.put("/workflows/enabled", async (req, res) => {
  const { repoPath, workflowId, enabled } = (req as any).body || {};
  if (!repoPath || !workflowId || typeof enabled !== "boolean") {
    return res.writeHead(400).end();
  }
  await setWorkflowEnabled(repoPath, workflowId, enabled);
  res.writeHead(200).end();
});

app.post("/workflows/run", async (req, res) => {
  const { repoPath, workflowId, commitId } = (req as any).body || {};
  if (!repoPath || !workflowId) {
    return res.writeHead(400).end();
  }
  const runnerNames = await runWorkflow(repoPath, workflowId, commitId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runnerName: runnerNames[0], runnerNames }));
});

app.post("/workflows/stop", async (req, res) => {
  const { runId } = (req as any).body || {};
  if (!runId) {
    return res.writeHead(400).end();
  }
  const success = await stopWorkflow(runId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ success }));
});

app.post("/workflows/retry", async (req, res) => {
  const { runId } = (req as any).body || {};
  if (!runId) {
    return res.writeHead(400).end();
  }
  const result = await retryRun(runId);
  if (!result) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Run not found" }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
});

app.get("/workflows/commits", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  const commitId = req.query.commitId as string;
  if (!repoPath || !commitId) {
    return res.writeHead(400).end();
  }
  const runs = await getRunsForCommit(repoPath, commitId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(runs));
});

app.get("/runs", async (req, res) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.writeHead(400).end();
  }
  const detail = await getRunDetail(runId);
  if (!detail) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ runId, status: "Unknown", workflowName: runId }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(detail));
});

app.get("/runs/timeline", async (req, res) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.writeHead(400).end();
  }
  const records = await getRunTimeline(runId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(records));
});

app.get("/runs/logs", async (req, res) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.writeHead(400).end();
  }
  const logs = await getRunLogs(runId);
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(logs);
});

app.get("/runs/errors", async (req, res) => {
  const runId = req.query.runId as string;
  if (!runId) {
    return res.writeHead(400).end();
  }
  const errors = await getRunErrors(runId);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(errors));
});

app.get("/runs/recent", async (req, res) => {
  const limit = parseInt(req.query.limit as string, 10) || 10;
  const runs = await getRecentRuns(limit);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(runs));
});

// Git
app.get("/git/branches", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) {
    return res.writeHead(400).end();
  }
  const branches = await getBranches(repoPath);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(branches));
});

app.get("/git/commits", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  const branch = req.query.branch as string;
  if (!repoPath || !branch) {
    return res.writeHead(400).end();
  }
  const commits = await getGitCommits(repoPath, branch);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(commits));
});

app.get("/git/working-tree", async (req, res) => {
  const repoPath = req.query.repoPath as string;
  if (!repoPath) {
    return res.writeHead(400).end();
  }
  const dirty = await getWorkingTreeStatus(repoPath);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ dirty }));
});

// DTU
app.get("/dtu", async (req, res) => {
  const status = await getDtuStatus();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status }));
});

app.post("/dtu", async (req, res) => {
  await startDtu();
  res.writeHead(200).end();
});

app.delete("/dtu", async (req, res) => {
  await stopDtu();
  res.writeHead(200).end();
});

// Concurrency
app.get("/concurrency", (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ max: getMaxConcurrentJobs() }));
});

app.put("/concurrency", async (req, res) => {
  const { max } = (req as any).body || {};
  if (typeof max !== "number" || max < 1) {
    return res.writeHead(400).end();
  }
  setMaxConcurrentJobs(max);

  // Persist to config file so the setting survives restarts
  try {
    const { DEFAULT_CONFIG_PATH, parseJsonc } = await import("../config.js");
    const fsSync = await import("node:fs");
    const pathMod = await import("node:path");
    fsSync.mkdirSync(pathMod.dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    let existing: Record<string, any> = {};
    if (fsSync.existsSync(DEFAULT_CONFIG_PATH)) {
      existing = parseJsonc(fsSync.readFileSync(DEFAULT_CONFIG_PATH, "utf-8"));
    }
    existing.maxConcurrentJobs = max;
    fsSync.writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.error("[OA Supervisor] Failed to persist concurrency to config:", err);
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ max: getMaxConcurrentJobs() }));
});

export async function startServer() {
  // On startup: kill any orphaned runner containers from a previous unclean shutdown.
  // This is a safety net so stale containers don't accumulate or conflict with new runs.
  killAllRunnerContainers();
  pruneOrphanedDockerResources();
  // Prune stale runner workspaces older than 24 hours (defense in depth)
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const pruned = pruneStaleWorkspaces(getWorkingDirectory(), TWENTY_FOUR_HOURS);
  if (pruned.length > 0) {
    console.log(`[OA Supervisor] Pruned ${pruned.length} stale workspace(s): ${pruned.join(", ")}`);
  }

  await loadWatchedRepos();
  app.listen(PORT, () => {
    console.log(`[OA Supervisor] Server listening on http://localhost:${PORT}`);
  });
  // Auto-start DTU at runtime
  startDtu();

  // Aggressive shutdown: kill ALL runner containers when the supervisor exits
  const gracefulShutdown = () => {
    console.log("\n[OA Supervisor] Shutting down — killing all runner containers...");
    killAllRunnerContainers();
    stopDtu();
    process.exit(0);
  };
  process.on("SIGINT", gracefulShutdown);
  process.on("SIGTERM", gracefulShutdown);
}
