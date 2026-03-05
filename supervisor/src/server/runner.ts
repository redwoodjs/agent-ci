import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { PROJECT_ROOT, getLogsDir, getNextLogNum } from "../logger.js";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./concurrency.js";
import { killRunnerContainers } from "../shutdown.js";
import { broadcastEvent } from "./events.js";
import { activeRuns } from "./run-store.js";

const execAsync = promisify(execFile);

// ─── Config ───────────────────────────────────────────────────────────────────

// Config path forwarded from the server startup (so spawned runners inherit the same --config)
let _configPath: string | undefined;
export function setOrchestratorConfigPath(p: string) {
  _configPath = p;
}

// Concurrency limiting for parallel job execution within a wave.
let _maxConcurrentJobs: number | undefined;

/** Set the maximum number of jobs that can run in parallel within a wave. */
export function setMaxConcurrentJobs(n: number) {
  _maxConcurrentJobs = n;
  supervisorLog(`[CONFIG] maxConcurrentJobs set to ${n}`);
}

export function getMaxConcurrentJobs(): number {
  return _maxConcurrentJobs ?? getDefaultMaxConcurrentJobs();
}

function getJobLimiter() {
  const max = _maxConcurrentJobs ?? getDefaultMaxConcurrentJobs();
  return createConcurrencyLimiter(max);
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

// ─── Runner numbering ─────────────────────────────────────────────────────────

let nextRunnerNum = getNextLogNum("oa-runner");

// ─── Job dependency resolution ────────────────────────────────────────────────

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

// ─── Job spawning ─────────────────────────────────────────────────────────────

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

// ─── Job setup  ───────────────────────────────────────────────────────────────

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

// ─── Retry ────────────────────────────────────────────────────────────────────

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

// ─── Workflow execution ───────────────────────────────────────────────────────

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

  // Use a concurrency limiter so we don't saturate the host when a wave has many jobs.
  const limiter = getJobLimiter();
  const effectiveMax = _maxConcurrentJobs ?? getDefaultMaxConcurrentJobs();
  supervisorLog(`[DEPS] Concurrency limit: ${effectiveMax} parallel jobs per wave`);

  await Promise.all(
    firstWave.map(({ taskId, runnerName, matrixContext }) =>
      limiter.run(() =>
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
        const waveLimiter = getJobLimiter();
        const results = await Promise.all(
          wave.map(({ taskId, runnerName, matrixContext }) =>
            waveLimiter.run(() =>
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
    // Kill the runner container, its service sidecars, and the bridge network
    killRunnerContainers(runId);
    return true;
  } catch {
    return false;
  }
}
