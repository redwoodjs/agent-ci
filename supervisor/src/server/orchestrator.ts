import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { ServerResponse } from "node:http";
import crypto from "node:crypto";
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

// Config path forwarded from the server startup (so spawned runners inherit the same --config)
let _configPath: string | undefined;
export function setOrchestratorConfigPath(p: string) {
  _configPath = p;
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

  // Per-repo debounce to prevent multiple rapid watcher events (logs/HEAD, HEAD,
  // refs/heads/…) for the same commit from spawning duplicate runners.
  let commitDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  const gitDir = path.join(repoPath, ".git");
  let watcher: fsSync.FSWatcher | null = null;
  try {
    watcher = fsSync.watch(gitDir, { recursive: true }, (_eventType, filename) => {
      if (
        filename &&
        (filename === "logs/HEAD" || filename === "HEAD" || filename.startsWith("refs/heads/"))
      ) {
        // Debounce: cancel any pending handler and re-schedule so only the last
        // event in a rapid burst triggers the actual work.
        if (commitDebounceTimer !== null) {
          clearTimeout(commitDebounceTimer);
        }
        commitDebounceTimer = setTimeout(async () => {
          commitDebounceTimer = null;
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
        }, 300);
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
    attempt: number;
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
    attempt: number;
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
          attempt: meta.attempt ?? 1,
        });
      } catch {
        // Skip entries with missing/invalid metadata
      }
    }
  } catch {
    // Logs dir doesn't exist yet
  }

  // Sort by numeric parts of the runner name so the order is stable regardless of
  // when each container starts (local-job.ts overwrites `date`, making it mutable).
  // - Between groups (different workflowRunId): higher runner number = newer run = first
  // - Within a group: ascending by suffix ordinal (001 < 002 < 003)
  const runnerNums = (name: string) => (name.match(/\d+/g) ?? []).map(Number);

  return results.sort((a, b) => {
    const aGroup = runnerNums(a.workflowRunId);
    const bGroup = runnerNums(b.workflowRunId);
    // Compare group numbers descending (newer first)
    for (let i = 0; i < Math.max(aGroup.length, bGroup.length); i++) {
      const diff = (bGroup[i] ?? 0) - (aGroup[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    // Same group — sort by full runner name ordinal ascending
    const aNums = runnerNums(a.runnerName);
    const bNums = runnerNums(b.runnerName);
    for (let i = 0; i < Math.max(aNums.length, bNums.length); i++) {
      const diff = (aNums[i] ?? 0) - (bNums[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  });
}

export async function getRecentRuns(limit = 10): Promise<
  {
    runId: string;
    workflowName: string;
    jobName: string | null;
    repoPath: string;
    status: string;
    date: number;
    endDate?: number;
  }[]
> {
  const logsDir = getLogsDir();
  const results: {
    runId: string;
    workflowName: string;
    jobName: string | null;
    repoPath: string;
    status: string;
    date: number;
    endDate?: number;
  }[] = [];

  // Only show runs from the user's registered repos (excludes test/temp repos)
  const allowedRepos = await getRecentRepos();

  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("oa-runner-")) {
        continue;
      }
      try {
        const metaPath = path.join(logsDir, entry.name, "metadata.json");
        const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
        // Skip runs not from a registered repo
        if (allowedRepos.length > 0 && !allowedRepos.includes(meta.repoPath)) {
          continue;
        }
        const docker = await getDockerContainerStatus(entry.name);
        const status = deriveRunStatus(entry.name, docker, meta.status);
        results.push({
          runId: entry.name,
          workflowName: meta.workflowName || entry.name,
          jobName: meta.jobName ?? null,
          repoPath: meta.repoPath || "",
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

  return results.sort((a, b) => b.date - a.date).slice(0, limit);
}

export async function getRunDetail(runId: string): Promise<{
  runId: string;
  runnerName: string;
  workflowName: string;
  status: string;
  date: number;
  endDate?: number;
  repoPath?: string;
  workflowPath?: string;
  commitId?: string;
  taskId?: string;
  workflowRunId?: string;
  attempt?: number;
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
      repoPath: meta.repoPath,
      workflowPath: meta.workflowPath,
      commitId: meta.commitId,
      taskId: meta.taskId ?? null,
      workflowRunId: meta.workflowRunId ?? runId,
      attempt: meta.attempt ?? 1,
    };
  } catch {
    return null;
  }
}

/**
 * Retry a specific failed run by spawning a new runner for the same job.
 * The new runner shares the original `workflowRunId` so retries are grouped together.
 */
export async function retryRun(
  runId: string,
): Promise<{ runnerName: string; attempt: number } | null> {
  const logsDir = getLogsDir();
  const metaPath = path.join(logsDir, runId, "metadata.json");
  let meta: any;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
  } catch {
    return null;
  }

  const { workflowPath, workflowName, repoPath, commitId, taskId, workflowRunId } = meta;
  if (!workflowPath || !repoPath) {
    return null;
  }

  // Count existing attempts with the same workflowRunId + taskId to derive next attempt number
  let maxAttempt = 0;
  try {
    const entries = await fs.readdir(logsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("oa-runner-")) {
        continue;
      }
      try {
        const m = JSON.parse(
          await fs.readFile(path.join(logsDir, entry.name, "metadata.json"), "utf-8"),
        );
        if (m.workflowRunId === workflowRunId && (m.taskId ?? null) === (taskId ?? null)) {
          maxAttempt = Math.max(maxAttempt, m.attempt ?? 1);
        }
      } catch {
        // skip
      }
    }
  } catch {
    // logs dir doesn't exist
  }
  const attempt = maxAttempt + 1;

  // Derive runner name from the original run ID: oa-runner-114-003 → oa-runner-114-003-001
  // Strip any existing attempt suffix (digits after a dash at the end that look like attempt nums)
  // The base is always the original runId itself.
  const runnerName = `${runId}-${String(attempt - 1).padStart(3, "0")}`;
  const runDir = path.join(logsDir, runnerName);
  const jobName = taskId ?? null;
  const workflowId = path.basename(workflowPath);

  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify(
      {
        workflowPath,
        workflowName,
        jobName,
        workflowRunId, // same group as original
        repoPath,
        commitId,
        date: Date.now(),
        taskId,
        attempt,
      },
      null,
      2,
    ),
  );

  activeRuns.add(runnerName);
  broadcastEvent("runStarted", {
    runId: runnerName,
    repoPath,
    workflowId,
    commitId,
    taskId,
    attempt,
  });

  // Pre-populate timeline (same logic as runWorkflow)
  try {
    const { parseWorkflowSteps, getWorkflowTemplate } = await import("../workflow-parser.js");
    let steps: any[] = [];
    if (taskId) {
      steps = (await parseWorkflowSteps(workflowPath, taskId)) as any[];
    } else {
      const tmpl = await getWorkflowTemplate(workflowPath);
      const firstJob = tmpl.jobs.find((j) => j.type === "job");
      if (firstJob && firstJob.type === "job") {
        steps = firstJob.steps.map((s, idx) => {
          const script = "run" in s ? ((s as any).run?.toString() ?? "") : "";
          const firstLine = script.split("\n").find((l: string) => l.trim()) ?? "";
          const derivedName =
            s.name?.toString() ??
            ("uses" in s
              ? (s as any).uses?.toString()
              : firstLine
                ? `Run ${firstLine.trim()}`
                : `Step ${idx + 1}`);
          return { Name: derivedName };
        });
      }
    }
    if (steps.length > 0) {
      const pendingRecords = steps.map((s: any, idx: number) => {
        let name = s.DisplayName || s.Name || `Step ${idx + 1}`;
        if (/^__run(_\d+)?$/.test(name) && s.Inputs?.script) {
          const firstLine =
            (s.Inputs.script as string).split("\n").find((l: string) => l.trim()) ?? "";
          if (firstLine) {
            name = `Run ${firstLine.trim()}`;
          }
        }
        return {
          id: crypto.randomUUID(),
          parentId: null,
          type: "Task",
          name,
          order: idx + 2,
          state: "pending",
          result: null,
          startTime: null,
          finishTime: null,
          refName: null,
        };
      });
      await fs.writeFile(
        path.join(runDir, "timeline.json"),
        JSON.stringify(pendingRecords, null, 2),
      );
    }
  } catch {
    // Best-effort
  }

  spawnRunner({
    fullPath: workflowPath,
    runnerName,
    runDir,
    commitId,
    taskId,
    repoPath,
    workflowId,
  });

  return { runnerName, attempt };
}

/**
 * Parse job `needs:` dependencies from raw workflow YAML.
 * Returns a Map<jobId, string[]> of upstream job IDs each job depends on.
 */
function parseJobDependencies(rawYaml: any): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  const jobs = rawYaml?.jobs ?? {};
  for (const [jobId, jobDef] of Object.entries<any>(jobs)) {
    const needs = jobDef?.needs;
    if (!needs) {
      deps.set(jobId, []);
    } else if (typeof needs === "string") {
      deps.set(jobId, [needs]);
    } else if (Array.isArray(needs)) {
      deps.set(jobId, needs.map(String));
    } else {
      deps.set(jobId, []);
    }
  }
  return deps;
}

/**
 * Topological sort of job IDs by their dependencies.
 * Returns an array of waves; each wave is a set of job IDs that can run in parallel.
 * Throws if there's a cycle.
 */
function topoSort(deps: Map<string, string[]>): string[][] {
  const waves: string[][] = [];
  const remaining = new Map(deps);
  const completed = new Set<string>();

  while (remaining.size > 0) {
    // Find jobs whose all dependencies are already completed
    const wave: string[] = [];
    for (const [jobId, needs] of remaining) {
      if (needs.every((n) => completed.has(n))) {
        wave.push(jobId);
      }
    }
    if (wave.length === 0) {
      // Cycle detected or unresolvable dependency — run remaining in one wave
      supervisorLog(`[DEPS] Cycle or unresolvable dependency, running remaining jobs together`);
      waves.push(Array.from(remaining.keys()));
      break;
    }
    for (const jobId of wave) {
      remaining.delete(jobId);
      completed.add(jobId);
    }
    waves.push(wave);
  }
  return waves;
}

/** Spawn a single runner process for a given workflow+task. Returns a Promise that resolves with the exit code. */
function spawnRunner({
  fullPath,
  runnerName,
  runDir,
  commitId,
  taskId,
  matrixContext,
  repoPath: _repoPath,
  workflowId: _workflowId,
}: {
  fullPath: string;
  runnerName: string;
  runDir: string;
  commitId: string;
  taskId?: string;
  matrixContext?: Record<string, string>;
  repoPath: string;
  workflowId: string;
}): Promise<number> {
  return new Promise((resolve) => {
    const supervisorDir = path.join(PROJECT_ROOT, "supervisor");
    const spawnArgs = ["npx", "tsx", "--env-file=.env", "src/cli.ts", "run"];
    if (_configPath) {
      spawnArgs.push("--config", _configPath);
    }
    if (commitId && commitId !== "WORKING_TREE") {
      spawnArgs.push(commitId);
    }
    spawnArgs.push("--workflow", fullPath);
    spawnArgs.push("--runner-name", runnerName);
    if (taskId) {
      spawnArgs.push("--task", taskId);
    }
    if (matrixContext && Object.keys(matrixContext).length > 0) {
      spawnArgs.push("--matrix", JSON.stringify(matrixContext));
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
      const exitCode = code ?? 1;
      const status = exitCode === 0 ? "Passed" : "Failed";
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
      resolve(exitCode);
    });

    // Sample container stats (CPU / memory) every 5s while the run is active.
    // Persist peak values into metadata so they survive after the container exits.
    (async () => {
      while (activeRuns.has(runnerName)) {
        try {
          const { stdout } = await execAsync(
            "docker",
            [
              "stats",
              "--no-stream",
              "--format",
              "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}",
              runnerName,
            ],
            { timeout: 5000 },
          );
          const [cpuStr, memStr, netStr] = stdout.trim().split("|");
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
          // NetIO: "1.2MB / 3.4MB" → parse rx / tx
          let netRxMB = 0;
          let netTxMB = 0;
          if (netStr) {
            const netParts = netStr.split("/").map((s) => s.trim());
            for (let ni = 0; ni < netParts.length; ni++) {
              const m = netParts[ni].match(/^([\d.]+)(\w+)/);
              if (m) {
                const v = parseFloat(m[1]);
                const u = m[2].toUpperCase();
                let mb = 0;
                if (u.startsWith("GB") || u.startsWith("GIB")) {
                  mb = v * 1024;
                } else if (u.startsWith("MB") || u.startsWith("MIB")) {
                  mb = v;
                } else if (u.startsWith("KB") || u.startsWith("KIB")) {
                  mb = v / 1024;
                } else if (u === "B") {
                  mb = v / (1024 * 1024);
                }
                if (ni === 0) {
                  netRxMB = mb;
                } else {
                  netTxMB = mb;
                }
              }
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
            if (!meta.peakNetRxMB || netRxMB > meta.peakNetRxMB) {
              meta.peakNetRxMB = Math.round(netRxMB * 10) / 10;
            }
            if (!meta.peakNetTxMB || netTxMB > meta.peakNetTxMB) {
              meta.peakNetTxMB = Math.round(netTxMB * 10) / 10;
            }
            if (!meta.statsHistory) {
              meta.statsHistory = [];
            }
            const sample = {
              ts: Date.now(),
              cpu: Math.round(cpu * 10) / 10,
              memMB: Math.round(memMB),
              netRxMB: Math.round(netRxMB * 10) / 10,
              netTxMB: Math.round(netTxMB * 10) / 10,
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
  });
}

/** Write metadata.json + initial timeline for a runner. Returns runDir. */
async function setupJob({
  fullPath,
  runnerName,
  workflowName,
  baseRunnerName,
  taskId,
  jobDisplayName,
  matrixContext,
  jobIds,
  repoPath,
  commitId,
  workflowId,
}: {
  fullPath: string;
  runnerName: string;
  workflowName: string;
  baseRunnerName: string;
  taskId: string | undefined;
  /** Human-readable job name from the `name:` field in the workflow YAML, falls back to taskId. */
  jobDisplayName?: string;
  matrixContext?: Record<string, string>;
  jobIds: string[];
  repoPath: string;
  commitId: string;
  workflowId: string;
}): Promise<string> {
  const runDir = path.join(getLogsDir(), runnerName);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, "metadata.json"),
    JSON.stringify(
      {
        workflowPath: fullPath,
        workflowName,
        jobName: (() => {
          if (!taskId) {
            return null;
          }
          const base = jobDisplayName ?? taskId;
          const idx = matrixContext?.__job_index;
          const total = matrixContext?.__job_total;
          if (idx !== undefined && total !== undefined) {
            return `${base} (${parseInt(idx) + 1}/${total})`;
          }
          return base;
        })(),
        workflowRunId: baseRunnerName,
        repoPath,
        commitId,
        date: Date.now(),
        taskId,
        attempt: 1,
        ...(matrixContext && Object.keys(matrixContext).length > 0 ? { matrixContext } : {}),
      },
      null,
      2,
    ),
  );

  activeRuns.add(runnerName);
  broadcastEvent("runStarted", { runId: runnerName, repoPath, workflowId, commitId, taskId });

  // Write initial timeline.json so the UI can show pending steps immediately.
  try {
    const { parseWorkflowSteps, getWorkflowTemplate } = await import("../workflow-parser.js");
    const jobIdForSteps = taskId ?? jobIds[0];
    let steps: any[] = [];
    if (jobIdForSteps) {
      steps = (await parseWorkflowSteps(fullPath, jobIdForSteps)) as any[];
    } else {
      const tmpl = await getWorkflowTemplate(fullPath);
      const firstJob = tmpl.jobs.find((j) => j.type === "job");
      if (firstJob && firstJob.type === "job") {
        steps = firstJob.steps.map((s, idx) => {
          const script = "run" in s ? ((s as any).run?.toString() ?? "") : "";
          const firstLine = script.split("\n").find((l: string) => l.trim()) ?? "";
          const derivedName =
            s.name?.toString() ??
            ("uses" in s
              ? (s as any).uses?.toString()
              : firstLine
                ? `Run ${firstLine.trim()}`
                : `Step ${idx + 1}`);
          return { Name: derivedName };
        });
      }
    }
    if (steps.length > 0) {
      const pendingRecords = steps.map((s: any, idx: number) => {
        let name = s.DisplayName || s.Name || `Step ${idx + 1}`;
        if (/^__run(_\d+)?$/.test(name) && s.Inputs?.script) {
          const firstLine =
            (s.Inputs.script as string).split("\n").find((l: string) => l.trim()) ?? "";
          if (firstLine) {
            name = `Run ${firstLine.trim()}`;
          }
        }
        return {
          id: crypto.randomUUID(),
          parentId: null,
          type: "Task",
          name,
          order: idx + 2,
          state: "pending",
          result: null,
          startTime: null,
          finishTime: null,
          refName: null,
        };
      });
      await fs.writeFile(
        path.join(runDir, "timeline.json"),
        JSON.stringify(pendingRecords, null, 2),
      );
    }
  } catch {
    // Best-effort
  }

  return runDir;
}

/** Prepare runDir + metadata + initial timeline for a job, then spawn it. Returns the exit code. */
async function setupAndSpawnJob(params: {
  fullPath: string;
  runnerName: string;
  workflowName: string;
  baseRunnerName: string;
  taskId: string | undefined;
  jobDisplayName?: string;
  matrixContext?: Record<string, string>;
  jobIds: string[];
  repoPath: string;
  commitId: string;
  workflowId: string;
}): Promise<number> {
  const runDir = await setupJob(params);
  return spawnRunner({
    fullPath: params.fullPath,
    runnerName: params.runnerName,
    runDir,
    commitId: params.commitId,
    taskId: params.taskId,
    matrixContext: params.matrixContext,
    repoPath: params.repoPath,
    workflowId: params.workflowId,
  });
}

export async function runWorkflow(
  repoPath: string,
  workflowId: string,
  commitId: string,
): Promise<string[]> {
  const fullPath = path.join(repoPath, ".github", "workflows", workflowId);
  const workflowName = workflowId.replace(/\.ya?ml$/, "");

  // Parse jobs, their needs: dependencies, and their matrix definitions
  let jobIds: string[] = [];
  let depWaves: string[][] = [];
  // Map from jobId → array of matrix combinations (each combo is a Record<string,string>)
  const matrixCombinations = new Map<string, Record<string, string>[]>();
  // Map from jobId → static display name (from the `name:` key in the workflow YAML)
  const jobDisplayNames = new Map<string, string>();
  try {
    const { getWorkflowTemplate, parseMatrixDef, expandMatrixCombinations } =
      await import("../workflow-parser.js");
    const yaml = (await import("yaml")).parse(await fs.readFile(fullPath, "utf-8"));
    const template = await getWorkflowTemplate(fullPath);
    jobIds = template.jobs.filter((j) => j.type === "job").map((j) => j.id.toString());

    // Collect static job display names from `name:` field in YAML
    for (const jobId of jobIds) {
      const yamlName = yaml?.jobs?.[jobId]?.name;
      if (typeof yamlName === "string" && yamlName.trim()) {
        jobDisplayNames.set(jobId, yamlName.trim());
      }
    }

    // Resolve matrix combinations for each job
    for (const jobId of jobIds) {
      const matrixDef = await parseMatrixDef(fullPath, jobId);
      if (matrixDef) {
        const combos = expandMatrixCombinations(matrixDef);
        const total = combos.length;
        // Inject __job_total and __job_index for strategy.job-total / strategy.job-index
        matrixCombinations.set(
          jobId,
          combos.map((combo, idx) => ({
            ...combo,
            __job_total: String(total),
            __job_index: String(idx),
          })),
        );
      } else {
        // No matrix → one "empty" combination
        matrixCombinations.set(jobId, [{}]);
      }
    }

    const deps = parseJobDependencies(yaml);
    depWaves = topoSort(deps);
    // Filter waves to only include jobs actually in the workflow
    depWaves = depWaves
      .map((w) => w.filter((id) => jobIds.includes(id)))
      .filter((w) => w.length > 0);
  } catch {
    // Can't parse — fall back to single-runner for the whole workflow
    depWaves = [];
  }

  // Claim the base runner number so all jobs share it
  const baseNum = nextRunnerNum++;
  const baseRunnerName = `oa-runner-${baseNum}`;

  // Count total expanded runners across all waves (one per matrix combination per job)
  const totalExpandedJobs = depWaves.reduce((sum, wave) => {
    return sum + wave.reduce((s, jobId) => s + (matrixCombinations.get(jobId)?.length ?? 1), 0);
  }, 0);

  const isMultiRunner = totalExpandedJobs > 1 || jobIds.length > 1;

  if (!isMultiRunner || depWaves.length === 0) {
    // Single-job, no-matrix workflow OR couldn't parse deps.
    // Preserve old behaviour: single runner, no -001 suffix, null jobName in metadata.
    const matrixContext = jobIds.length === 1 ? (matrixCombinations.get(jobIds[0])?.[0] ?? {}) : {};
    const hasMatrix = Object.keys(matrixContext).filter((k) => !k.startsWith("__")).length > 0;
    // For a true single-job+no-matrix workflow: taskId=undefined so jobName=null in UI.
    // For a single-job+matrix workflow (only 1 combination, unusual): still use taskId.
    const taskId = hasMatrix || jobIds.length > 1 ? jobIds[0] : undefined;
    const runnerName = baseRunnerName; // single runner always gets plain name
    const runDir = await setupJob({
      fullPath,
      runnerName,
      workflowName,
      baseRunnerName,
      taskId,
      jobDisplayName: taskId ? jobDisplayNames.get(taskId) : undefined,
      matrixContext: hasMatrix ? matrixContext : undefined,
      jobIds,
      repoPath,
      commitId,
      workflowId,
    });
    // Now spawn without awaiting (process may run for minutes)
    spawnRunner({
      fullPath,
      runnerName,
      runDir,
      commitId,
      taskId,
      matrixContext: hasMatrix ? matrixContext : undefined,
      repoPath,
      workflowId,
    }).catch(() => {});
    return [runnerName];
  }

  // Multi-runner with dependency waves: pre-compute ALL runner names.
  // Each job is expanded by its matrix combinations.
  // Global sequential index across all waves/jobs/combinations.
  let globalJobIndex = 0;
  const waveRunnerPlan: Array<
    Array<{ taskId: string; runnerName: string; matrixContext: Record<string, string> }>
  > = depWaves.map((wave) =>
    wave.flatMap((taskId) => {
      const combos = matrixCombinations.get(taskId) ?? [{}];
      return combos.map((combo) => {
        globalJobIndex++;
        return {
          taskId,
          runnerName: `${baseRunnerName}-${String(globalJobIndex).padStart(3, "0")}`,
          matrixContext: combo,
        };
      });
    }),
  );
  const allRunnerNames = waveRunnerPlan.flat().map(({ runnerName }) => runnerName);

  // Pre-create minimal Pending metadata for wave-2+ runners so they appear in the UI
  // immediately rather than being invisible until wave 1 completes.
  for (const wave of waveRunnerPlan.slice(1)) {
    for (const { taskId, runnerName, matrixContext } of wave) {
      const runDir = path.join(getLogsDir(), runnerName);
      await fs.mkdir(runDir, { recursive: true });
      const base = jobDisplayNames.get(taskId) ?? taskId;
      const idx = matrixContext?.__job_index;
      const total = matrixContext?.__job_total;
      const jobName =
        idx !== undefined && total !== undefined ? `${base} (${parseInt(idx) + 1}/${total})` : base;
      await fs.writeFile(
        path.join(runDir, "metadata.json"),
        JSON.stringify(
          {
            workflowPath: fullPath,
            workflowName,
            jobName,
            workflowRunId: baseRunnerName,
            repoPath,
            commitId,
            date: Date.now(),
            taskId,
            attempt: 1,
            status: "Pending",
            ...(Object.keys(matrixContext).filter((k) => !k.startsWith("__")).length > 0
              ? { matrixContext }
              : {}),
          },
          null,
          2,
        ),
      );
    }
  }

  const firstWave = waveRunnerPlan[0];
  const remainingWaves = waveRunnerPlan.slice(1);

  await Promise.all(
    firstWave.map(({ taskId, runnerName, matrixContext }) =>
      setupAndSpawnJob({
        fullPath,
        runnerName,
        workflowName,
        baseRunnerName,
        taskId,
        jobDisplayName: jobDisplayNames.get(taskId),
        matrixContext: Object.keys(matrixContext).length > 0 ? matrixContext : undefined,
        jobIds,
        repoPath,
        commitId,
        workflowId,
      }).then((code) => code),
    ),
  ).then((firstWaveResults) => {
    if (remainingWaves.length === 0) {
      return;
    }
    const anyFailed = firstWaveResults.some((code) => code !== 0);
    if (anyFailed) {
      supervisorLog(`[DEPS] Wave 1 had failures — aborting remaining waves`);
      return;
    }

    // Run remaining waves sequentially in the background
    (async () => {
      for (let wi = 0; wi < remainingWaves.length; wi++) {
        const wave = remainingWaves[wi];
        supervisorLog(
          `[DEPS] Starting wave ${wi + 2}/${depWaves.length}: [${wave.map((r) => r.taskId).join(", ")}]`,
        );
        const results = await Promise.all(
          wave.map(({ taskId, runnerName, matrixContext }) =>
            setupAndSpawnJob({
              fullPath,
              runnerName,
              workflowName,
              baseRunnerName,
              taskId,
              jobDisplayName: jobDisplayNames.get(taskId),
              matrixContext: Object.keys(matrixContext).length > 0 ? matrixContext : undefined,
              jobIds,
              repoPath,
              commitId,
              workflowId,
            }),
          ),
        );
        if (results.some((code) => code !== 0)) {
          supervisorLog(`[DEPS] Wave ${wi + 2} had failures — aborting remaining waves`);
          break;
        }
      }
    })();
  });

  return allRunnerNames;
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
  netRxMB?: number;
  netTxMB?: number;
  peakCpu?: number;
  peakMemMB?: number;
  peakNetRxMB?: number;
  peakNetTxMB?: number;
  imageSizeMB?: number;
  live: boolean;
}> {
  // Try live docker stats first
  let live = false;
  let cpu: number | undefined;
  let memMB: number | undefined;
  let netRxMB: number | undefined;
  let netTxMB: number | undefined;

  try {
    const { stdout } = await execAsync(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}", runId],
      { timeout: 5000 },
    );
    const [cpuStr, memStr, netStr] = stdout.trim().split("|");
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
    // NetIO: "1.2MB / 3.4MB"
    if (netStr) {
      const netParts = netStr.split("/").map((s) => s.trim());
      for (let ni = 0; ni < netParts.length; ni++) {
        const m = netParts[ni].match(/^([\d.]+)(\w+)/);
        if (m) {
          const v = parseFloat(m[1]);
          const u = m[2].toUpperCase();
          let mb = 0;
          if (u.startsWith("GB") || u.startsWith("GIB")) {
            mb = v * 1024;
          } else if (u.startsWith("MB") || u.startsWith("MIB")) {
            mb = v;
          } else if (u.startsWith("KB") || u.startsWith("KIB")) {
            mb = v / 1024;
          } else if (u === "B") {
            mb = v / (1024 * 1024);
          }
          if (ni === 0) {
            netRxMB = Math.round(mb * 10) / 10;
          } else {
            netTxMB = Math.round(mb * 10) / 10;
          }
        }
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
  let peakNetRxMB: number | undefined;
  let peakNetTxMB: number | undefined;
  try {
    const metaPath = path.join(getLogsDir(), runId, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    peakCpu = meta.peakCpu;
    peakMemMB = meta.peakMemMB;
    peakNetRxMB = meta.peakNetRxMB;
    peakNetTxMB = meta.peakNetTxMB;
  } catch {}

  return {
    cpu,
    memMB,
    netRxMB,
    netTxMB,
    peakCpu,
    peakMemMB,
    peakNetRxMB,
    peakNetTxMB,
    imageSizeMB,
    live,
  };
}

export async function getStatsHistory(
  runId: string,
): Promise<Array<{ ts: number; cpu: number; memMB: number; netRxMB?: number; netTxMB?: number }>> {
  try {
    const metaPath = path.join(getLogsDir(), runId, "metadata.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    return meta.statsHistory || [];
  } catch {
    return [];
  }
}

export async function getRunTimeline(runId: string): Promise<
  Array<{
    id: string;
    name: string;
    type: string;
    order: number;
    state: string;
    result: string | null;
    startTime: string | null;
    finishTime: string | null;
    refName: string | null;
    parentId: string | null;
  }>
> {
  // The DTU timeline handler merges pre-populated records with runner updates,
  // preserving friendly names. Just read the file directly.
  const timelinePath = path.join(getLogsDir(), runId, "timeline.json");
  try {
    const raw = await fs.readFile(timelinePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {}

  return [];
}

export async function getRunLogs(runId: string): Promise<string> {
  // Prefer the DTU's step-output.log (clean, no ##[group] noise)
  const stepOutputPath = path.join(getLogsDir(), runId, "step-output.log");
  try {
    const content = await fs.readFile(stepOutputPath, "utf-8");
    if (content.trim()) {
      return content;
    }
  } catch {}

  const logsDir = getLogsDir();
  // Fall back to process-stdout.log (from orchestrator spawn), then output.log
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

export interface RunAnnotation {
  /** "error" | "warning" | "notice" */
  severity: string;
  /** The message text (with the ##[error] prefix stripped) */
  message: string;
  /** 1-based line number in the log file */
  line: number;
  /** Surrounding ±3 lines of context from the log */
  context: string[];
}

/**
 * Parse the log file for a given run and extract structured annotations
 * (##[error], ##[warning], ##[notice]) with line numbers and context.
 */
export async function getRunErrors(runId: string): Promise<RunAnnotation[]> {
  // Read the same log file that getRunLogs uses
  const logContent = await getRunLogs(runId);
  if (!logContent) {
    return [];
  }

  const lines = logContent.split("\n");
  const annotations: RunAnnotation[] = [];

  // Timestamp regex matching the ISO timestamps in log lines
  const tsRegex = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/;
  // ANSI escape sequence regex (use constructor to avoid no-control-regex lint warning)
  const ESC = String.fromCharCode(27);
  const ansiRegex = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip ANSI and BOM for marker detection
    const stripped = raw.replace(ansiRegex, "").replace(/\uFEFF/g, "");

    const match = stripped.match(/##\[(error|warning|notice)\](.*)/);
    if (!match) {
      continue;
    }

    const severity = match[1];
    const message = match[2].trim();

    // Gather ±3 lines of context, stripping timestamps for readability
    const contextStart = Math.max(0, i - 3);
    const contextEnd = Math.min(lines.length - 1, i + 3);
    const context: string[] = [];
    for (let j = contextStart; j <= contextEnd; j++) {
      const contextLine = lines[j]
        .replace(ansiRegex, "")
        .replace(/\uFEFF/g, "")
        .replace(tsRegex, "");
      context.push(contextLine);
    }

    annotations.push({
      severity,
      message,
      line: i + 1, // 1-based
      context,
    });
  }

  return annotations;
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
