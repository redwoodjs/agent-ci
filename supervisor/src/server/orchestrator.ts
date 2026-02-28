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
const getWorkflowOverridesPath = () => path.join(OA_DIR, "workflows.json");

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
  await loadWorkflowOverrides();
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

            // Auto-run logic — only run workflows that are enabled
            const workflows = await getWorkflows(repoPath);
            for (const { id } of workflows) {
              if (await getWorkflowEnabledState(repoPath, id)) {
                await runWorkflow(repoPath, id, currentCommit);
              }
            }
          }
        } catch {}
      }
    });
  } catch (e: any) {
    // Silently ignore missing directories (e.g. non-existent repos in tests)
    if (e?.code !== "ENOENT") {
      console.error(`Failed to watch ${gitDir}`, e);
    }
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

// ─── Workflow enabled/disabled overrides ─────────────────────────────────────
// Map<repoPath, Map<workflowId, enabled>> — user-set overrides only.
// If no override is present, default is derived from triggers.
const workflowEnabledOverrides = new Map<string, Map<string, boolean>>();

async function loadWorkflowOverrides() {
  try {
    const data = await fs.readFile(getWorkflowOverridesPath(), "utf-8");
    const parsed: Record<string, Record<string, boolean>> = JSON.parse(data);
    for (const [repo, overrides] of Object.entries(parsed)) {
      workflowEnabledOverrides.set(repo, new Map(Object.entries(overrides)));
    }
  } catch {
    // file doesn't exist yet
  }
}

async function saveWorkflowOverrides() {
  await ensureOaDir();
  const out: Record<string, Record<string, boolean>> = {};
  for (const [repo, overrides] of workflowEnabledOverrides.entries()) {
    out[repo] = Object.fromEntries(overrides.entries());
  }
  await fs.writeFile(getWorkflowOverridesPath(), JSON.stringify(out, null, 2));
}

/**
 * Parse the `on:` triggers from a workflow YAML file.
 * Returns an array of trigger event names, e.g. ["push", "pull_request"].
 */
export function getWorkflowTriggers(content: string): string[] {
  try {
    // Quick regex-based extraction of the top-level `on:` key
    // Handles both `on: push` and `on:\n  push:` forms
    const onMatch = content.match(/^on:\s*(.+)$/m);
    if (!onMatch) {
      return [];
    }
    const rest = onMatch[1].trim();
    // Inline form: `on: [push, pull_request]` or `on: push`
    if (rest.startsWith("[")) {
      return rest
        .replace(/\[|\]/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (rest && rest !== "") {
      return [rest];
    }
    // Block form: parse subsequent indented keys
    const blockMatch = content.match(/^on:\s*\n((?:^  \S[^\n]*\n?)+)/m);
    if (blockMatch) {
      return blockMatch[1]
        .split("\n")
        .map((l) => l.match(/^  (\S+):/)?.[1])
        .filter((s): s is string => !!s);
    }
  } catch {}
  return [];
}

/** Returns true if a workflow should be auto-run by default based on its triggers. */
export function isEnabledByDefault(triggers: string[]): boolean {
  return triggers.some((t) => t === "push" || t === "pull_request");
}

/** Get the effective enabled state for a workflow (override wins, else trigger-based default). */
export async function getWorkflowEnabledState(
  repoPath: string,
  workflowId: string,
): Promise<boolean> {
  const repoOverrides = workflowEnabledOverrides.get(repoPath);
  if (repoOverrides && repoOverrides.has(workflowId)) {
    return repoOverrides.get(workflowId)!;
  }
  // Fall back to trigger-based default
  const workflowsPath = path.join(repoPath, ".github", "workflows");
  try {
    const content = await fs.readFile(path.join(workflowsPath, workflowId), "utf-8");
    return isEnabledByDefault(getWorkflowTriggers(content));
  } catch {
    return true; // default to enabled if file can't be read
  }
}

/** Get a map of workflowId -> effective enabled state for all workflows in a repo. */
export async function getWorkflowEnabledMap(
  repoPath: string,
  workflows: { id: string }[],
): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const wf of workflows) {
    result[wf.id] = await getWorkflowEnabledState(repoPath, wf.id);
  }
  return result;
}

/** Set an explicit override for a workflow's enabled state. */
export async function setWorkflowEnabled(
  repoPath: string,
  workflowId: string,
  enabled: boolean,
): Promise<void> {
  if (!workflowEnabledOverrides.has(repoPath)) {
    workflowEnabledOverrides.set(repoPath, new Map());
  }
  workflowEnabledOverrides.get(repoPath)!.set(workflowId, enabled);
  await saveWorkflowOverrides();
}

// Workflows
export async function getWorkflows(
  repoPath: string,
): Promise<{ id: string; name: string; triggers: string[]; enabledByDefault: boolean }[]> {
  const workflowsPath = path.join(repoPath, ".github", "workflows");
  const workflows: { id: string; name: string; triggers: string[]; enabledByDefault: boolean }[] =
    [];
  try {
    const files = await fs.readdir(workflowsPath, { withFileTypes: true });
    for (const file of files) {
      if (file.isFile() && (file.name.endsWith(".yml") || file.name.endsWith(".yaml"))) {
        const fullPath = path.join(workflowsPath, file.name);
        const content = await fs.readFile(fullPath, "utf-8");
        const nameMatch = content.match(/^name:\s*(.+)$/m);
        const triggers = getWorkflowTriggers(content);
        workflows.push({
          id: file.name,
          name: nameMatch ? nameMatch[1].trim() : file.name,
          triggers,
          enabledByDefault: isEnabledByDefault(triggers),
        });
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
): Promise<
  {
    runId: string;
    runnerName: string;
    workflowName: string;
    jobName: string | null;
    workflowRunId: string;
    status: string;
    date: number;
    endDate?: number;
  }[]
> {
  const logsDir = getLogsDir();
  const results: {
    runId: string;
    runnerName: string;
    workflowName: string;
    jobName: string | null;
    workflowRunId: string;
    status: string;
    date: number;
    endDate?: number;
  }[] = [];

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
          runnerName: entry.name,
          workflowName: meta.workflowName || entry.name,
          jobName: meta.jobName ?? null,
          workflowRunId: meta.workflowRunId ?? entry.name,
          status,
          date: meta.date || 0,
          endDate: meta.endDate,
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

export async function getRunDetail(runId: string): Promise<{
  runId: string;
  runnerName: string;
  workflowName: string;
  status: string;
  date: number;
  endDate?: number;
} | null> {
  const logsDir = getLogsDir();
  const metaPath = path.join(logsDir, runId, "metadata.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    const docker = await getDockerContainerStatus(runId);
    const status = deriveRunStatus(runId, docker, meta.status);
    return {
      runId,
      runnerName: runId,
      workflowName: meta.workflowName || runId,
      status,
      date: meta.date || 0,
      endDate: meta.endDate,
    };
  } catch {
    return null;
  }
}

/** Spawn a single runner process for a given workflow+task and return its runnerName. */
function spawnRunner({
  fullPath,
  runnerName,
  runDir,
  commitId,
  taskId,
  repoPath: _repoPath,
  workflowId: _workflowId,
}: {
  fullPath: string;
  runnerName: string;
  runDir: string;
  commitId: string;
  taskId?: string;
  repoPath: string;
  workflowId: string;
}): void {
  const supervisorDir = path.join(PROJECT_ROOT, "supervisor");
  const spawnArgs = ["npx", "tsx", "--env-file=.env", "src/cli.ts", "run"];
  if (commitId && commitId !== "WORKING_TREE") {
    spawnArgs.push(commitId);
  }
  spawnArgs.push("--workflow", fullPath);
  spawnArgs.push("--runner-name", runnerName);
  if (taskId) {
    spawnArgs.push("--task", taskId);
  }

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
    const endDate = Date.now();
    // Persist status and endDate to metadata so it survives even without Docker
    try {
      const metaPath = path.join(runDir, "metadata.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
      meta.status = status;
      meta.endDate = endDate;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    } catch {}
    broadcastEvent("runFinished", { runId: runnerName, status });
  });

  // Sample container stats (CPU / memory) every 5s while the run is active.
  // Persist peak values into metadata so they survive after the container exits.
  (async () => {
    while (activeRuns.has(runnerName)) {
      try {
        const { stdout } = await execAsync(
          "docker",
          ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", runnerName],
          { timeout: 5000 },
        );
        const [cpuStr, memStr] = stdout.trim().split("|");
        // CPUPerc: "3.14%" → 3.14
        const cpu = parseFloat(cpuStr?.replace("%", "") ?? "0");
        // MemUsage: "123MiB / 7.77GiB" → take left side in MiB
        const memMatch = memStr?.match(/^([\d.]+)(\w+)/);
        let memMB = 0;
        if (memMatch) {
          const val = parseFloat(memMatch[1]);
          const unit = memMatch[2].toUpperCase();
          if (unit.startsWith("GIB") || unit.startsWith("GB")) {
            memMB = val * 1024;
          } else if (unit.startsWith("MIB") || unit.startsWith("MB")) {
            memMB = val;
          } else if (unit.startsWith("KIB") || unit.startsWith("KB")) {
            memMB = val / 1024;
          }
        }
        if (!isNaN(cpu) || memMB > 0) {
          const metaPath = path.join(runDir, "metadata.json");
          const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
          if (!meta.peakCpu || cpu > meta.peakCpu) {
            meta.peakCpu = Math.round(cpu * 10) / 10;
          }
          if (!meta.peakMemMB || memMB > meta.peakMemMB) {
            meta.peakMemMB = Math.round(memMB);
          }
          if (!meta.statsHistory) {
            meta.statsHistory = [];
          }
          const sample = {
            ts: Date.now(),
            cpu: Math.round(cpu * 10) / 10,
            memMB: Math.round(memMB),
          };
          meta.statsHistory.push(sample);
          await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
          broadcastEvent("runStatsSample", { runId: runnerName, ...sample });
        }
      } catch {
        // Container not running yet or already gone
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  })();
}

export async function runWorkflow(
  repoPath: string,
  workflowId: string,
  commitId: string,
): Promise<string[]> {
  const fullPath = path.join(repoPath, ".github", "workflows", workflowId);
  const workflowName = workflowId.replace(/\.ya?ml$/, "");

  // Determine which job(s) to run. If the workflow has multiple jobs we
  // spawn one runner per job rather than erroring with "Multiple tasks found".
  let jobIds: string[] = [];
  try {
    const { getWorkflowTemplate } = await import("../workflow-parser.js");
    const template = await getWorkflowTemplate(fullPath);
    jobIds = template.jobs.filter((j) => j.type === "job").map((j) => j.id.toString());
  } catch {
    // If we can't parse the workflow, fall back to single-runner (cli will handle it)
  }

  // Common entry-point heuristic (mirrors cli.ts logic)
  const COMMON_ENTRY_POINTS = ["test", "ci", "run", "build"];
  if (jobIds.length > 1) {
    const found = COMMON_ENTRY_POINTS.find((n) => jobIds.includes(n));
    if (found) {
      // Single obvious entry point — no need to fan out
      jobIds = [found];
    }
  }

  // Claim the base runner number now (before the loop) so all jobs share it
  const baseNum = nextRunnerNum++;
  const baseRunnerName = `oa-runner-${baseNum}`;
  const isMultiJob = jobIds.length > 1;

  // Fan out: one runner per job (or one runner with no --task for single-job workflows)
  const tasksToRun: (string | undefined)[] = isMultiJob ? jobIds : [undefined];
  const runnerNames: string[] = [];

  for (let i = 0; i < tasksToRun.length; i++) {
    const taskId = tasksToRun[i];
    // Multi-job: oa-runner-N-001, oa-runner-N-002; single-job: oa-runner-N
    const runnerName = isMultiJob
      ? `${baseRunnerName}-${String(i + 1).padStart(3, "0")}`
      : baseRunnerName;
    const runDir = path.join(getLogsDir(), runnerName);

    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, "metadata.json"),
      JSON.stringify(
        {
          workflowPath: fullPath,
          workflowName,
          jobName: taskId ?? null, // null for single-job runs
          workflowRunId: baseRunnerName, // groups jobs that belong to the same run
          repoPath,
          commitId,
          date: Date.now(),
          taskId,
        },
        null,
        2,
      ),
    );

    activeRuns.add(runnerName);
    broadcastEvent("runStarted", { runId: runnerName, repoPath, workflowId, commitId, taskId });

    spawnRunner({ fullPath, runnerName, runDir, commitId, taskId, repoPath, workflowId });
    runnerNames.push(runnerName);
  }

  return runnerNames;
}

export async function stopWorkflow(runId: string) {
  try {
    await execAsync("docker", ["rm", "-f", runId]);
    return true;
  } catch {
    return false;
  }
}

/** Returns live stats for a running container, or persisted peak stats for a finished one. */
export async function getRunStats(runId: string): Promise<{
  cpu?: number;
  memMB?: number;
  peakCpu?: number;
  peakMemMB?: number;
  imageSizeMB?: number;
  live: boolean;
}> {
  // Try live docker stats first
  let live = false;
  let cpu: number | undefined;
  let memMB: number | undefined;

  try {
    const { stdout } = await execAsync(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", runId],
      { timeout: 5000 },
    );
    const [cpuStr, memStr] = stdout.trim().split("|");
    const parsedCpu = parseFloat(cpuStr?.replace("%", "") ?? "");
    if (!isNaN(parsedCpu)) {
      cpu = Math.round(parsedCpu * 10) / 10;
      live = true;
    }
    const memMatch = memStr?.match(/^([\d.]+)(\w+)/);
    if (memMatch) {
      const val = parseFloat(memMatch[1]);
      const unit = memMatch[2].toUpperCase();
      if (unit.startsWith("GIB") || unit.startsWith("GB")) {
        memMB = Math.round(val * 1024);
      } else if (unit.startsWith("MIB") || unit.startsWith("MB")) {
        memMB = Math.round(val);
      } else if (unit.startsWith("KIB") || unit.startsWith("KB")) {
        memMB = Math.round(val / 1024);
      }
    }
  } catch {
    // Container not running
  }

  // Try image size via docker image inspect
  let imageSizeMB: number | undefined;
  try {
    const { stdout } = await execAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Size}}", "ghcr.io/actions/actions-runner:latest"],
      { timeout: 5000 },
    );
    const bytes = parseInt(stdout.trim(), 10);
    if (!isNaN(bytes)) {
      imageSizeMB = Math.round(bytes / 1024 / 1024);
    }
  } catch {}

  // Also pull persisted peak stats from metadata
  let peakCpu: number | undefined;
  let peakMemMB: number | undefined;
  try {
    const metaPath = path.join(getLogsDir(), runId, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    peakCpu = meta.peakCpu;
    peakMemMB = meta.peakMemMB;
  } catch {}

  return { cpu, memMB, peakCpu, peakMemMB, imageSizeMB, live };
}

export async function getStatsHistory(
  runId: string,
): Promise<Array<{ ts: number; cpu: number; memMB: number }>> {
  try {
    const metaPath = path.join(getLogsDir(), runId, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    return meta.statsHistory || [];
  } catch {
    return [];
  }
}

export async function getRunLogs(runId: string): Promise<string> {
  const logsDir = getLogsDir();
  // Try process-stdout.log first (from orchestrator spawn), then output.log (from executeLocalJob)
  for (const filename of ["process-stdout.log", "output.log"]) {
    const logPath = path.join(logsDir, runId, filename);
    try {
      const content = await fs.readFile(logPath, "utf-8");
      if (content.trim()) {
        return content;
      }
    } catch {}
  }
  // Fall back to stderr so errors like "Multiple tasks found" are surfaced in the UI
  try {
    const stderrPath = path.join(logsDir, runId, "process-stderr.log");
    const stderr = await fs.readFile(stderrPath, "utf-8");
    if (stderr.trim()) {
      return stderr;
    }
  } catch {}
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

/**
 * Override the readiness check used by startDtu().
 * In tests, inject a function that resolves immediately (or after a short delay)
 * so the test doesn't need an actual service running on port 8910.
 *
 * @example
 *   // In a vitest test:
 *   setDtuReadinessCheck(() => Promise.resolve(true));
 */
let dtuReadinessCheck: () => Promise<boolean> = async () => {
  try {
    const res = await fetch("http://localhost:8910").catch(() => null);
    return !!(res && res.ok);
  } catch {
    return false;
  }
};

export function setDtuReadinessCheck(fn: () => Promise<boolean>) {
  dtuReadinessCheck = fn;
}

export async function getDtuStatus() {
  // Only verify reachability when we believe Running but have no live process
  // (i.e. the process reference has been lost but status wasn't updated).
  // When dtuProcess is non-null the process is authoritative.
  if (dtuStatus === "Running" && !dtuProcess) {
    try {
      const reachable = await dtuReadinessCheck();
      if (!reachable) {
        setDtuStatus("Failed");
      }
    } catch {
      setDtuStatus("Failed");
    }
  }
  return dtuStatus;
}

type SpawnFn = typeof spawn;

function defaultDtuSpawner(): ReturnType<SpawnFn> {
  const rootCwd = PROJECT_ROOT;
  console.log(`[DTU] Starting dtu-github-actions from ${rootCwd}`);
  return spawn("pnpm", ["--filter", "dtu-github-actions", "dev"], {
    cwd: rootCwd,
    env: process.env,
    stdio: "pipe",
  });
}

let dtuSpawner: () => ReturnType<SpawnFn> = defaultDtuSpawner;

/**
 * Override the process spawner used by startDtu().
 * In tests, inject a factory that returns a controllable mock process.
 *
 * @example
 *   // In a vitest test:
 *   const { EventEmitter } = await import("node:events");
 *   setDtuSpawner(() => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); return p as any; });
 */
export function setDtuSpawner(fn: () => ReturnType<SpawnFn>) {
  dtuSpawner = fn;
}

/** Reset DTU state for use in tests. Clears any live process reference and resets status to Stopped. */
export function resetDtuStateForTest() {
  if (dtuProcess) {
    try {
      dtuProcess.kill();
    } catch {}
  }
  dtuProcess = null;
  dtuStatus = "Stopped";
  dtuReadinessCheck = async () => {
    try {
      const res = await fetch("http://localhost:8910").catch(() => null);
      return !!(res && res.ok);
    } catch {
      return false;
    }
  };
  dtuSpawner = defaultDtuSpawner;
}
export async function startDtu() {
  if (dtuProcess || dtuStatus === "Running" || dtuStatus === "Starting") {
    return;
  }
  setDtuStatus("Starting");

  dtuProcess = dtuSpawner();

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

  // Poll using the (potentially overridden) readiness check instead of a fixed timeout
  const maxAttempts = 20;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!dtuProcess) {
      // Process already exited
      return;
    }
    try {
      const ready = await dtuReadinessCheck();
      if (ready) {
        console.log(`[DTU] Readiness check passed, DTU is running`);
        setDtuStatus("Running");
        return;
      }
    } catch {}
  }

  // If we get here, the DTU didn't respond in time
  if (dtuProcess) {
    console.error(`[DTU] Readiness check failed after ${maxAttempts * 500}ms`);
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
