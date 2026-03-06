import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import crypto from "node:crypto";
import { parse as parseYaml } from "yaml";
import { getRunsDir, getNextLogNum } from "../logger.js";
import { PROJECT_ROOT, getWorkingDirectory } from "../working-directory.js";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./concurrency.js";
import { killRunnerContainers, pruneOrphanedDockerResources } from "../shutdown.js";
import { broadcastEvent } from "./events.js";
import { activeRuns } from "./run-store.js";
import { isWarmNodeModules, computeLockfileHash } from "../cleanup.js";
import {
  parseWorkflowSteps,
  getWorkflowTemplate,
  parseMatrixDef,
  expandMatrixCombinations,
} from "../workflow-parser.js";

// ─── Warm launch plan ─────────────────────────────────────────────────────────

/**
 * Run a wave of jobs, serializing the first one when the warm node_modules
 * dir is cold and there are multiple parallel jobs.
 *
 * Exported so it can be unit-tested with a spy spawner.
 *
 * @param jobs     Array of job descriptors for the wave.
 * @param warm     Whether the shared node_modules dir is already populated.
 * @param spawn    Async function to launch a single job; must return its exit code.
 * @returns        Array of exit codes in wave order.
 */
export async function runWaveWithWarmSerialization<T extends { runnerName: string }>(
  jobs: T[],
  warm: boolean,
  spawn: (job: T) => Promise<number>,
): Promise<number[]> {
  if (!warm && jobs.length > 1) {
    // Cold + multi-job: run the first job alone, then the rest in parallel.
    const [first, ...rest] = jobs;
    const firstResult = await spawn(first);
    const restResults = await Promise.all(rest.map(spawn));
    return [firstResult, ...restResults];
  }
  // Warm or single job: launch all in parallel.
  return Promise.all(jobs.map(spawn));
}

// ─── Config ───────────────────────────────────────────────────────────────────

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
  const logPath = path.join(getWorkingDirectory(), "supervisor.log");
  try {
    fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
    fsSync.appendFileSync(logPath, line);
  } catch {}
}

// ─── Runner numbering ─────────────────────────────────────────────────────────

let nextRunnerNum = getNextLogNum("machinen");

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
    stdoutLog.on("error", () => {}); // suppress ENOENT if logDir is cleaned up
    const stderrLog = fsSync.createWriteStream(path.join(runDir, "process-stderr.log"));
    stderrLog.on("error", () => {}); // suppress ENOENT if logDir is cleaned up

    const cliArgsLine = `[OA Runner] CLI args: ${spawnArgs.join(" ")}`;
    console.log(cliArgsLine);
    stdoutLog.write(cliArgsLine + "\n");
    const proc = spawn(spawnArgs[0], spawnArgs.slice(1), {
      cwd: supervisorDir,
      env: { ...process.env, OA_WORKING_DIR: getWorkingDirectory() },
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
  warmCache,
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
  /** Whether this job's node_modules dir was pre-populated (warm) or empty (cold) at wave start. */
  warmCache?: boolean;
}): Promise<string> {
  const runDir = path.join(getRunsDir(), runnerName);
  const logDir = path.join(runDir, "logs");
  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "metadata.json"),
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
        status: "Running",
        taskId,
        attempt: 1,
        ...(warmCache !== undefined ? { warmCache } : {}),
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
        path.join(logDir, "timeline.json"),
        JSON.stringify(pendingRecords, null, 2),
      );
    }
  } catch {
    // Best-effort
  }

  return logDir;
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
  warmCache?: boolean;
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
  const logsDir = getRunsDir();
  const metaPath = path.join(logsDir, runId, "logs", "metadata.json");
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
      if (!entry.isDirectory() || !entry.name.startsWith("machinen-")) {
        continue;
      }
      try {
        const m = JSON.parse(
          await fs.readFile(path.join(logsDir, entry.name, "logs", "metadata.json"), "utf-8"),
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

  // New runner name appends -r<attempt> (e.g. machinen-redwoodjssdk-14-r2).
  const runnerName = `${runId}-r${attempt}`;
  const runDir = path.join(logsDir, runnerName);
  const logDir = path.join(runDir, "logs");
  const jobName = taskId ?? null;
  const workflowId = path.basename(workflowPath);

  await fs.mkdir(logDir, { recursive: true });
  await fs.writeFile(
    path.join(logDir, "metadata.json"),
    JSON.stringify(
      {
        workflowPath,
        workflowName,
        jobName,
        workflowRunId, // same group as original
        repoPath,
        commitId,
        date: Date.now(),
        status: "Running",
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
        path.join(logDir, "timeline.json"),
        JSON.stringify(pendingRecords, null, 2),
      );
    }
  } catch {
    // Best-effort
  }

  spawnRunner({
    fullPath: workflowPath,
    runnerName,
    runDir: logDir,
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
    const yaml = parseYaml(await fs.readFile(fullPath, "utf-8"));
    // Extract job IDs directly from the YAML instead of using getWorkflowTemplate
    // (which depends on @actions/workflow-parser that has a Node.js v22 JSON import issue)
    jobIds = Object.keys(yaml?.jobs ?? {});

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
  // Derive a short repo slug from the repoPath for human-readable runner names.
  let repoSlug = repoPath.replace(/.*\//, "").replace("/", "-"); // fallback: repo basename
  try {
    const remoteUrl = execSync("git remote get-url origin", { cwd: repoPath, stdio: "pipe" })
      .toString()
      .trim();
    const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) {
      // e.g. "redwoodjs/sdk" → "redwoodjs-sdk"
      repoSlug = match[1].replace("/", "-");
    }
  } catch {
    // Best-effort — keep the directory basename fallback
  }
  const baseRunnerName = `machinen-${repoSlug}-${baseNum}`;

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
    // runDir is the logDir returned by setupJob — spawn writes process-stdout.log there
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
      return combos.map((combo, comboIdx) => {
        globalJobIndex++;
        // Only add -jJ suffix for multi-job workflows
        // Only add -mM suffix when the job has a matrix
        const hasMatrix = Object.keys(combo).filter((k) => !k.startsWith("__")).length > 0;
        const isMultiJob = jobIds.length > 1;
        let suffix = "";
        if (isMultiJob) {
          suffix += `-j${globalJobIndex}`;
        }
        // For matrix: use the global matrix position index within this job
        if (hasMatrix) {
          suffix += `-m${comboIdx + 1}`;
        }
        return {
          taskId,
          runnerName: `${baseRunnerName}${suffix}`,
          matrixContext: combo,
        };
      });
    }),
  );
  const allRunnerNames = waveRunnerPlan.flat().map(({ runnerName }) => runnerName);

  // Pre-create minimal Pending metadata for ALL runners so they appear in the UI
  // immediately rather than being invisible until actually spawned.
  for (const wave of waveRunnerPlan) {
    for (const { taskId, runnerName, matrixContext } of wave) {
      const runDir = path.join(getRunsDir(), runnerName);
      const logDir = path.join(runDir, "logs");
      await fs.mkdir(logDir, { recursive: true });
      const base = jobDisplayNames.get(taskId) ?? taskId;
      const idx = matrixContext?.__job_index;
      const total = matrixContext?.__job_total;
      const jobName =
        idx !== undefined && total !== undefined ? `${base} (${parseInt(idx) + 1}/${total})` : base;
      await fs.writeFile(
        path.join(logDir, "metadata.json"),
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

  // ── Warm node_modules serialization ──────────────────────────────────────────
  // If the first wave has multiple jobs and the warm node_modules dir is cold
  // (empty / never populated), run ONE job alone first so it can run pnpm install
  // and populate the shared bind-mounted node_modules. Subsequent jobs then find
  // node_modules already in place and pnpm install exits in under a second.
  // If the dir is already warm (lockfile unchanged from a prior run), skip straight
  // to the normal parallel launch.
  // Derive repoSlug the same way we computed baseRunnerName above.
  // warmModulesDir is now under <workDir>/cache/warm-modules/
  let lockfileHash = "no-lockfile";
  try {
    lockfileHash = computeLockfileHash(repoPath);
  } catch {
    // Best-effort
  }
  const warmModulesDir = path.join(
    getWorkingDirectory(),
    "cache",
    "warm-modules",
    repoSlug,
    lockfileHash,
  );
  const warm = isWarmNodeModules(warmModulesDir);
  supervisorLog(
    `[WARM] node_modules dir: ${warmModulesDir} (${warm ? "warm" : "cold"}, hash=${lockfileHash})`,
  );

  // Update wave-1 pre-created pending metadata with warmCache so the UI shows
  // the correct badge immediately (before actual spawn).
  // Cold path: first job = false (does the install), rest = true (reuse warm cache).
  // Warm path: all = true.
  if (waveRunnerPlan.length > 0) {
    const wave1 = waveRunnerPlan[0];
    for (let i = 0; i < wave1.length; i++) {
      const { runnerName } = wave1[i];
      const metaPath = path.join(getRunsDir(), runnerName, "logs", "metadata.json");
      try {
        const existing = JSON.parse(await fs.readFile(metaPath, "utf-8"));
        existing.warmCache = warm || i > 0; // first job cold only if cache is cold
        await fs.writeFile(metaPath, JSON.stringify(existing, null, 2));
      } catch {
        /* best-effort */
      }
    }
  }

  // Use a concurrency limiter so we don't saturate the host when a wave has many jobs.
  const limiter = getJobLimiter();
  const effectiveMax = _maxConcurrentJobs ?? getDefaultMaxConcurrentJobs();
  supervisorLog(`[DEPS] Concurrency limit: ${effectiveMax} parallel jobs per wave`);

  // Helper: run a wave job through the limiter.
  const spawnJob = (
    taskId: string,
    runnerName: string,
    matrixContext: Record<string, string>,
    jobWarmCache: boolean,
  ) =>
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
        warmCache: jobWarmCache,
      }),
    );

  // Prune orphaned networks once before launching any concurrent runners.
  // Must not be called inside per-runner code (startServiceContainers) because
  // concurrent runners would race to delete each other's freshly-created networks.
  pruneOrphanedDockerResources();

  let firstWaveResultsPromise: Promise<number[]>;

  if (!warm && firstWave.length > 1) {
    supervisorLog(
      `[WARM] Cold node_modules with ${firstWave.length} parallel jobs — serializing first job to warm the cache`,
    );
    // First job: cold (does the actual pnpm install).
    // Remaining jobs: warm (node_modules populated by the first job).
    let firstJobDone = false;
    firstWaveResultsPromise = runWaveWithWarmSerialization(
      firstWave,
      false,
      ({ taskId, runnerName, matrixContext }) => {
        const isWarm = firstJobDone;
        firstJobDone = true;
        return spawnJob(taskId, runnerName, matrixContext, isWarm);
      },
    ).then((results) => {
      supervisorLog(
        `[WARM] Warm job finished — node_modules now populated, launching ${firstWave.length - 1} remaining job(s)`,
      );
      return results;
    });
  } else {
    // Warm cache or single job: launch all in parallel normally.
    firstWaveResultsPromise = runWaveWithWarmSerialization(
      firstWave,
      true,
      ({ taskId, runnerName, matrixContext }) => spawnJob(taskId, runnerName, matrixContext, warm),
    );
  }

  // Kick off wave execution in the background — runWorkflow returns the runner names
  // immediately so the HTTP handler can respond. Waves run concurrently in the background.
  (async () => {
    let firstWaveResults: number[];
    try {
      firstWaveResults = await firstWaveResultsPromise;
    } catch {
      return;
    }

    if (remainingWaves.length === 0) {
      return;
    }
    const anyFailed = firstWaveResults.some((code) => code !== 0);
    if (anyFailed) {
      supervisorLog(`[DEPS] Wave 1 had failures — aborting remaining waves`);
      return;
    }

    // Run remaining waves sequentially in the background
    for (let wi = 0; wi < remainingWaves.length; wi++) {
      const wave = remainingWaves[wi];
      supervisorLog(
        `[DEPS] Starting wave ${wi + 2}/${depWaves.length}: [${wave.map((r) => r.taskId).join(", ")}]`,
      );
      pruneOrphanedDockerResources();
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
