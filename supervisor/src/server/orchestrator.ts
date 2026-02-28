import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ServerResponse } from "node:http";
import { PROJECT_ROOT, getLogsDir, getNextLogNum } from "../logger.js";

const execAsync = promisify(execFile);

// Manage SSE Connections
const sseClients = new Set<ServerResponse>();

export function addSSEClient(res: ServerResponse) {
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
}

export function broadcastEvent(type: string, payload: any) {
  const entry = { type, ...payload, timestamp: Date.now() };
  eventLog.push(entry);
  if (eventLog.length > 100) {
    eventLog.shift();
  }
  const data = JSON.stringify(entry);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// In-memory event log (ring buffer, last 100 events)
const eventLog: Array<{ type: string; timestamp: number; [key: string]: any }> = [];

export function getEventLog() {
  return eventLog;
}

export function clearEventLog() {
  eventLog.length = 0;
}

// Config Paths
const OA_DIR = path.join(PROJECT_ROOT, "_");
const getRecentReposPath = () => path.join(OA_DIR, "recent_repos.json");
const getWatchedReposPath = () => path.join(OA_DIR, "watched_repos.json");

async function ensureOaDir() {
  await fs.mkdir(OA_DIR, { recursive: true });
}

// ─── Supervisor audit log ─────────────────────────────────────────────────────

function supervisorLog(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  const logPath = path.join(getLogsDir(), "supervisor.log");
  try {
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    fsSync.appendFileSync(logPath, line);
  } catch {}
}

// Recent Repos
export async function getRecentRepos(): Promise<string[]> {
  try {
    const data = await fs.readFile(getRecentReposPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function addRecentRepo(repoPath: string) {
  await ensureOaDir();
  let repos = await getRecentRepos();
  repos = [repoPath, ...repos.filter((p: string) => p !== repoPath)].slice(0, 10);
  await fs.writeFile(getRecentReposPath(), JSON.stringify(repos, null, 2));
}

export async function removeRecentRepo(repoPath: string) {
  let repos = await getRecentRepos();
  repos = repos.filter((p: string) => p !== repoPath);
  await fs.writeFile(getRecentReposPath(), JSON.stringify(repos, null, 2));
}

// Watched Repos (State + FS Watcher)
const watchedRepos = new Map<
  string,
  { watcher: fsSync.FSWatcher | null; lastCommit: string; lastBranch: string }
>();

export async function loadWatchedRepos() {
  try {
    const data = await fs.readFile(getWatchedReposPath(), "utf-8");
    const repos: string[] = JSON.parse(data);
    for (const r of repos) {
      await enableWatchMode(r);
    }
  } catch {
    // file doesn't exist
  }
}

async function saveWatchedRepos() {
  await ensureOaDir();
  const repos = Array.from(watchedRepos.keys());
  await fs.writeFile(getWatchedReposPath(), JSON.stringify(repos, null, 2));
}

export async function getWatchedRepos(): Promise<string[]> {
  return Array.from(watchedRepos.keys());
}

export async function enableWatchMode(repoPath: string) {
  if (watchedRepos.has(repoPath)) {
    return;
  }

  let lastCommit = "";
  let lastBranch = "";
  try {
    const { stdout } = await execAsync("git", ["log", "-1", "--format=%H"], { cwd: repoPath });
    lastCommit = stdout.trim();
  } catch {}
  try {
    const { stdout } = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoPath,
    });
    lastBranch = stdout.trim();
  } catch {}

  const gitDir = path.join(repoPath, ".git");
  let watcher: fsSync.FSWatcher | null = null;
  try {
    watcher = fsSync.watch(gitDir, { recursive: true }, async (_eventType, filename) => {
      if (
        filename &&
        (filename === "logs/HEAD" || filename === "HEAD" || filename.startsWith("refs/heads/"))
      ) {
        try {
          const { stdout } = await execAsync("git", ["log", "-1", "--format=%H"], {
            cwd: repoPath,
          });
          const currentCommit = stdout.trim();
          const watchData = watchedRepos.get(repoPath);

          // Detect branch switch
          try {
            const { stdout: branchOut } = await execAsync(
              "git",
              ["rev-parse", "--abbrev-ref", "HEAD"],
              { cwd: repoPath },
            );
            const currentBranch = branchOut.trim();
            if (watchData && currentBranch && currentBranch !== watchData.lastBranch) {
              watchData.lastBranch = currentBranch;
              broadcastEvent("branchChanged", { repoPath, branch: currentBranch });
            }
          } catch {}

          // Detect new commits
          if (watchData && currentCommit && currentCommit !== watchData.lastCommit) {
            watchData.lastCommit = currentCommit;
            broadcastEvent("commitDetected", { repoPath, commitId: currentCommit });

            // Auto-run logic
            const workflows = await getWorkflows(repoPath);
            for (const { id } of workflows) {
              await runWorkflow(repoPath, id, currentCommit);
            }
          }
        } catch {}
      }
    });
  } catch (e) {
    console.error(`Failed to watch ${gitDir}`, e);
  }

  // Also watch .github/workflows for changes
  const workflowsDir = path.join(repoPath, ".github", "workflows");
  try {
    fsSync.watch(workflowsDir, async () => {
      broadcastEvent("workflowsChanged", { repoPath });
    });
  } catch {
    // Ignore if no .github/workflows exists
  }

  watchedRepos.set(repoPath, { watcher, lastCommit, lastBranch });
  await saveWatchedRepos();
}

export async function disableWatchMode(repoPath: string) {
  const watchData = watchedRepos.get(repoPath);
  if (watchData) {
    if (watchData.watcher) {
      watchData.watcher.close();
    }
    watchedRepos.delete(repoPath);
    await saveWatchedRepos();
  }
}

// Workflows
export async function getWorkflows(repoPath: string): Promise<{ id: string; name: string }[]> {
  const workflowsPath = path.join(repoPath, ".github", "workflows");
  const workflows: { id: string; name: string }[] = [];
  try {
    const files = await fs.readdir(workflowsPath, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && (file.name.endsWith(".yml") || file.name.endsWith(".yaml"))) {
        const fullPath = path.join(workflowsPath, file.name);
        const content = await fs.readFile(fullPath, "utf-8");
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        workflows.push({ id: file.name, name: nameMatch ? nameMatch[1].trim() : file.name });
      }
    }
  } catch {}
  return workflows;
}

let nextRunnerNum = getNextLogNum("oa-runner");

// Track runs whose spawned process is still alive so we can report "Running"
// even before the Docker container exists or after it's been removed.
const activeRuns = new Set<string>();

async function getDockerContainerStatus(
  containerName: string,
): Promise<{ running: boolean; exitCode: number | null }> {
  try {
    const { stdout } = await execAsync("docker", [
      "inspect",
      "--format",
      "{{.State.Running}}|{{.State.ExitCode}}",
      containerName,
    ]);
    const [running, exitCode] = stdout.trim().split("|");
    return {
      running: running === "true",
      exitCode: exitCode !== undefined ? parseInt(exitCode, 10) : null,
    };
  } catch {
    // Container doesn't exist (already removed or never started)
    return { running: false, exitCode: null };
  }
}

function deriveRunStatus(
  runId: string,
  docker: { running: boolean; exitCode: number | null },
  metadataStatus?: string,
): string {
  if (docker.running) {
    return "Running";
  }
  if (docker.exitCode === 0) {
    return "Passed";
  }
  if (docker.exitCode !== null) {
    return "Failed";
  }
  // The spawned process is still alive (container may not exist yet or was already removed)
  if (activeRuns.has(runId)) {
    return "Running";
  }
  // Fall back to status persisted in metadata.json
  if (metadataStatus) {
    return metadataStatus;
  }
  return "Unknown";
}

export async function getRunsForCommit(
  repoPath: string,
  commitId: string,
): Promise<{ runId: string; workflowName: string; status: string; date: number }[]> {
  const logsDir = getLogsDir();
  const results: { runId: string; workflowName: string; status: string; date: number }[] = [];

  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("oa-runner-")) {
        continue;
      }
      try {
        const metaPath = path.join(logsDir, entry.name, "metadata.json");
        const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
        if (meta.repoPath !== repoPath || meta.commitId !== commitId) {
          continue;
        }
        const docker = await getDockerContainerStatus(entry.name);
        const status = deriveRunStatus(entry.name, docker, meta.status);
        results.push({
          runId: entry.name,
          workflowName: meta.workflowName || entry.name,
          status,
          date: meta.date || 0,
        });
      } catch {
        // Skip entries with missing/invalid metadata
      }
    }
  } catch {
    // Logs dir doesn't exist yet
  }

  return results.sort((a, b) => b.date - a.date);
}

export async function getRunDetail(
  runId: string,
): Promise<{ runId: string; workflowName: string; status: string; date: number } | null> {
  const logsDir = getLogsDir();
  const metaPath = path.join(logsDir, runId, "metadata.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    const docker = await getDockerContainerStatus(runId);
    const status = deriveRunStatus(runId, docker, meta.status);
    return {
      runId,
      workflowName: meta.workflowName || runId,
      status,
      date: meta.date || 0,
    };
  } catch {
    return null;
  }
}

export async function runWorkflow(repoPath: string, workflowId: string, commitId: string) {
  const fullPath = path.join(repoPath, ".github", "workflows", workflowId);
  const runnerName = `oa-runner-${nextRunnerNum++}`;
  const runDir = path.join(getLogsDir(), runnerName);
  const workflowName = workflowId.replace(/\.ya?ml$/, "");

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify(
      { workflowPath: fullPath, workflowName, repoPath, commitId, date: Date.now() },
      null,
      2,
    ),
  );

  activeRuns.add(runnerName);
  broadcastEvent("runStarted", { runId: runnerName, repoPath, workflowId, commitId });

  const supervisorDir = path.join(PROJECT_ROOT, "supervisor");
  const spawnArgs = ["npx", "tsx", "--env-file=.env", "src/cli.ts", "run"];
  if (commitId && commitId !== "WORKING_TREE") {
    spawnArgs.push(commitId);
  }
  spawnArgs.push("--workflow", fullPath);
  spawnArgs.push("--runner-name", runnerName);

  const stdoutLog = fsSync.createWriteStream(path.join(runDir, "process-stdout.log"));
  const stderrLog = fsSync.createWriteStream(path.join(runDir, "process-stderr.log"));

  const proc = spawn(spawnArgs[0], spawnArgs.slice(1), {
    cwd: supervisorDir,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pipe stderr directly to file
  proc.stderr?.pipe(stderrLog);

  // Stream stdout line-by-line: write to log file AND broadcast via SSE
  if (proc.stdout) {
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      stdoutLog.write(line + "\n");
      broadcastEvent("runLog", { runId: runnerName, line });
    });
  }

  supervisorLog(`[RUN] Spawned ${runnerName}: ${spawnArgs.join(" ")} (cwd=${supervisorDir})`);

  proc.on("error", (err) => {
    supervisorLog(`[RUN] ${runnerName} spawn error: ${err.message}`);
  });

  proc.on("close", async (code, signal) => {
    activeRuns.delete(runnerName);
    supervisorLog(
      `[RUN] ${runnerName} exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
    );
    stdoutLog.end();
    stderrLog.end();
    const status = code === 0 ? "Passed" : "Failed";
    // Persist status to metadata so it survives even without Docker
    try {
      const metaPath = path.join(runDir, "metadata.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
      meta.status = status;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch {}
    broadcastEvent("runFinished", { runId: runnerName, status });
  });

  return runnerName;
}

export async function stopWorkflow(runId: string) {
  try {
    await execAsync("docker", ["rm", "-f", runId]);
    return true;
  } catch {
    return false;
  }
}

export async function getRunLogs(runId: string): Promise<string> {
  const logsDir = getLogsDir();
  // Try process-stdout.log first (from orchestrator spawn), then output.log (from executeLocalJob)
  for (const filename of ["process-stdout.log", "output.log"]) {
    const logPath = path.join(logsDir, runId, filename);
    try {
      return await fs.readFile(logPath, "utf-8");
    } catch {}
  }
  return "";
}

// DTU Management
let dtuProcess: ReturnType<typeof spawn> | null = null;
let dtuStatus: "Stopped" | "Starting" | "Running" | "Failed" | "Error" = "Stopped";

function setDtuStatus(newStatus: typeof dtuStatus) {
  if (dtuStatus !== newStatus) {
    dtuStatus = newStatus;
    broadcastEvent("dtuStatusChanged", { status: dtuStatus });
  }
}

export async function getDtuStatus() {
  // If it claims to be running, verify it's reachable on 8910
  if (dtuStatus === "Running") {
    try {
      const res = await fetch("http://localhost:8910").catch(() => null);
      if (!res) {
        setDtuStatus("Failed");
      }
    } catch {
      setDtuStatus("Failed");
    }
  }
  return dtuStatus;
}

export async function startDtu() {
  if (dtuProcess || dtuStatus === "Running" || dtuStatus === "Starting") {
    return;
  }
  setDtuStatus("Starting");

  const rootCwd = PROJECT_ROOT;
  console.log(`[DTU] Starting dtu-github-actions from ${rootCwd}`);

  dtuProcess = spawn("pnpm", ["--filter", "dtu-github-actions", "dev"], {
    cwd: rootCwd,
    env: process.env,
    stdio: "pipe",
  });

  dtuProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[DTU] ${data.toString()}`);
  });

  dtuProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[DTU Error] ${data.toString()}`);
  });

  dtuProcess.on("error", (err) => {
    console.error(`[DTU] Failed to start: ${err.message}`);
    dtuProcess = null;
    setDtuStatus("Failed");
  });

  dtuProcess.on("close", (code) => {
    console.log(`[DTU] Process exited with code ${code}`);
    dtuProcess = null;
    if (code !== 0 && code !== null) {
      setDtuStatus("Failed");
    } else {
      setDtuStatus("Stopped");
    }
  });

  // Poll for port 8910 to become reachable instead of a fixed timeout
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!dtuProcess) {
      // Process already exited
      return;
    }
    try {
      const res = await fetch("http://localhost:8910").catch(() => null);
      if (res && res.ok) {
        console.log(`[DTU] Port 8910 is reachable, DTU is running`);
        setDtuStatus("Running");
        return;
      }
    } catch {}
  }

  // If we get here, the DTU didn't respond in time
  if (dtuProcess) {
    console.error(`[DTU] Port 8910 not reachable after ${maxAttempts * 500}ms`);
    setDtuStatus("Failed");
  }
}

export async function stopDtu() {
  if (dtuProcess) {
    dtuProcess.kill();
    dtuProcess = null;
    setDtuStatus("Stopped");
  } else {
    // Failsafe in case it was started by another daemon
    try {
      await execAsync("lsof", ["-t", "-i", ":8910"]).then(({ stdout }) => {
        if (stdout) {
          execAsync("kill", ["-9", ...stdout.trim().split("\n")]);
        }
      });
    } catch {}
    setDtuStatus("Stopped");
  }
}
