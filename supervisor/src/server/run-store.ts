import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

// ─── Active runs (shared with runner.ts via export) ───────────────────────────
// Track runs whose spawned process is still alive so we can report "Running"
// even before the Docker container exists or after it's been removed.
export const activeRuns = new Set<string>();

// ─── Per-repo run directory ───────────────────────────────────────────────────

import { getWorkingDirectory } from "../working-directory.js";

/**
 * Returns the `runs/` directory for a given repository.
 * All run state now lives under the OS temporary directory scoped to the repo.
 */
function getRunsDirForRepo(_repoPath: string): string {
  // getWorkingDirectory() is now centrally configured to os.tmpdir()/machinen/<repo>
  return path.join(getWorkingDirectory(), "runs");
}

/**
 * Resolve which repo's runs/ directory a runId lives in.
 * Checks each registered repo's .machinen/runs/ dir.
 */
async function resolveRunDir(runId: string, knownRepoPaths: string[]): Promise<string | null> {
  for (const repoPath of knownRepoPaths) {
    const candidate = path.join(getRunsDirForRepo(repoPath), runId);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // not in this repo
    }
  }
  return null;
}

// ─── Docker helpers ───────────────────────────────────────────────────────────

export async function getDockerContainerStatus(
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

export function deriveRunStatus(runId: string, metadataStatus?: string): string {
  // activeRuns is the authoritative source for "is this job live right now".
  // The Set is populated in setupJob() and cleared in proc.on("close").
  if (activeRuns.has(runId)) {
    return "Running";
  }
  // After the process exits, metadata.status is persisted ("Passed" / "Failed" / "Pending").
  if (metadataStatus) {
    return metadataStatus;
  }
  return "Unknown";
}

// ─── Run queries ──────────────────────────────────────────────────────────────

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
    warmCache?: boolean;
  }[]
> {
  const runsDir = getRunsDirForRepo(repoPath);
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
    warmCache?: boolean;
  }[] = [];

  try {
    const entries = await fs.readdir(runsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("machinen-")) {
        continue;
      }
      try {
        const metaPath = path.join(runsDir, entry.name, "logs", "metadata.json");
        const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
        if (meta.repoPath !== repoPath || meta.commitId !== commitId) {
          continue;
        }
        const status = deriveRunStatus(entry.name, meta.status);
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
          warmCache: meta.warmCache,
        });
      } catch {
        // Skip entries with missing/invalid metadata
      }
    }
  } catch {
    // .machinen/runs/ dir doesn't exist yet
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
  const { getRecentRepos } = await import("./repos.js");
  const allowedRepos = await getRecentRepos();

  // Scan each registered repo's own .machinen/runs/ directory
  for (const repoPath of allowedRepos) {
    const runsDir = getRunsDirForRepo(repoPath);
    try {
      const entries = await fs.readdir(runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("machinen-")) {
          continue;
        }
        try {
          const metaPath = path.join(runsDir, entry.name, "logs", "metadata.json");
          const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
          const status = deriveRunStatus(entry.name, meta.status);
          results.push({
            runId: entry.name,
            workflowName: meta.workflowName || entry.name,
            jobName: meta.jobName ?? null,
            repoPath: meta.repoPath || repoPath,
            status,
            date: meta.date || 0,
            endDate: meta.endDate,
          });
        } catch {
          // Skip entries with missing/invalid metadata
        }
      }
    } catch {
      // .machinen/runs/ doesn't exist for this repo yet
    }
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
  warmCache?: boolean;
} | null> {
  const { getRecentRepos } = await import("./repos.js");
  const allRepos = await getRecentRepos();

  const runDir = await resolveRunDir(runId, allRepos);
  if (!runDir) {
    return null;
  }

  const metaPath = path.join(runDir, "logs", "metadata.json");
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    const status = deriveRunStatus(runId, meta.status);
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
      warmCache: meta.warmCache,
    };
  } catch {
    return null;
  }
}

// ─── Run stats ────────────────────────────────────────────────────────────────

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
    const { getRecentRepos } = await import("./repos.js");
    const allRepos = await getRecentRepos();
    const runDir = await resolveRunDir(runId, allRepos);
    if (runDir) {
      const metaPath = path.join(runDir, "logs", "metadata.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
      peakCpu = meta.peakCpu;
      peakMemMB = meta.peakMemMB;
      peakNetRxMB = meta.peakNetRxMB;
      peakNetTxMB = meta.peakNetTxMB;
    }
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
    const { getRecentRepos } = await import("./repos.js");
    const allRepos = await getRecentRepos();
    const runDir = await resolveRunDir(runId, allRepos);
    if (!runDir) {
      return [];
    }
    const metaPath = path.join(runDir, "logs", "metadata.json");
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
  const { getRecentRepos } = await import("./repos.js");
  const allRepos = await getRecentRepos();
  const runDir = await resolveRunDir(runId, allRepos);
  if (!runDir) {
    return [];
  }

  const timelinePath = path.join(runDir, "logs", "timeline.json");
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
  const { getRecentRepos } = await import("./repos.js");
  const allRepos = await getRecentRepos();
  const runDir = await resolveRunDir(runId, allRepos);
  if (!runDir) {
    return "";
  }

  // Prefer the DTU's step-output.log (clean, no ##[group] noise)
  const stepOutputPath = path.join(runDir, "logs", "step-output.log");
  try {
    const content = await fs.readFile(stepOutputPath, "utf-8");
    if (content.trim()) {
      return content;
    }
  } catch {}

  // Fall back to process-stdout.log, then output.log
  for (const filename of ["process-stdout.log", "output.log"]) {
    const logPath = path.join(runDir, "logs", filename);
    try {
      const content = await fs.readFile(logPath, "utf-8");
      if (content.trim()) {
        return content;
      }
    } catch {}
  }

  // Fall back to stderr so errors like "Multiple tasks found" are surfaced in the UI
  try {
    const stderrPath = path.join(runDir, "logs", "process-stderr.log");
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
