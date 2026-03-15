import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { config, loadMachineSecrets } from "./config.js";
import { getNextLogNum } from "./output/logger.js";
import {
  setWorkingDirectory,
  DEFAULT_WORKING_DIR,
  PROJECT_ROOT,
} from "./output/working-directory.js";
import { debugCli } from "./output/debug.js";

import { executeLocalJob } from "./runner/local-job.js";
import {
  getWorkflowTemplate,
  parseWorkflowSteps,
  parseWorkflowServices,
  parseWorkflowContainer,
  validateSecrets,
  parseMatrixDef,
  expandMatrixCombinations,
  isWorkflowRelevant,
  getChangedFiles,
  parseJobOutputDefs,
  parseJobIf,
  evaluateJobIf,
  parseFailFast,
} from "./workflow/workflow-parser.js";
import { resolveJobOutputs } from "./runner/result-builder.js";
import { Job } from "./types.js";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./output/concurrency.js";
import { isWarmNodeModules, computeLockfileHash } from "./output/cleanup.js";
import { getWorkingDirectory } from "./output/working-directory.js";
import { pruneOrphanedDockerResources } from "./docker/shutdown.js";
import { parseJobDependencies, topoSort } from "./workflow/job-scheduler.js";
import { printSummary, type JobResult } from "./output/reporter.js";
import { syncWorkspaceForRetry } from "./runner/sync.js";
import { RunStateStore } from "./output/run-state.js";
import { renderRunState } from "./output/state-renderer.js";
import { isAgentMode, setQuietMode } from "./output/agent-mode.js";
import logUpdate from "log-update";

// ─── Signal helpers for retry / abort commands ────────────────────────────────

function findSignalsDir(runnerName: string): string | null {
  const workDir = getWorkingDirectory();
  const runsDir = path.resolve(workDir, "runs");
  if (!fs.existsSync(runsDir)) {
    return null;
  }
  for (const entry of fs.readdirSync(runsDir)) {
    if (entry === runnerName || entry.endsWith(runnerName)) {
      const signalsDir = path.join(runsDir, entry, "signals");
      if (fs.existsSync(signalsDir)) {
        return signalsDir;
      }
    }
  }
  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "run") {
    let sha: string | undefined;
    let workflow: string | undefined;
    let pauseOnFailure = false;
    let runAll = false;

    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "--workflow" || args[i] === "-w") && args[i + 1]) {
        workflow = args[i + 1];
        i++;
      } else if (args[i] === "--pause-on-failure" || args[i] === "-p") {
        pauseOnFailure = true;
      } else if (args[i] === "--all" || args[i] === "-a") {
        runAll = true;
      } else if (args[i] === "--quiet" || args[i] === "-q") {
        setQuietMode(true);
      } else if (!args[i].startsWith("-")) {
        sha = args[i];
      }
    }

    let workingDir = process.env.AGENT_CI_WORKING_DIR;
    if (workingDir) {
      if (!path.isAbsolute(workingDir)) {
        workingDir = path.resolve(PROJECT_ROOT, workingDir);
      }
      setWorkingDirectory(workingDir);
    }

    if (runAll) {
      // Discover all relevant workflows for the current branch
      const repoRoot = resolveRepoRoot();
      const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
      if (!fs.existsSync(workflowsDir)) {
        console.error(`[Agent CI] No .github/workflows directory found in ${repoRoot}`);
        process.exit(1);
      }

      const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot })
        .toString()
        .trim();

      const changedFiles = getChangedFiles(repoRoot);

      const files = fs
        .readdirSync(workflowsDir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map((f) => path.join(workflowsDir, f));

      const relevant: string[] = [];
      for (const file of files) {
        try {
          const { parse: parseYaml } = await import("yaml");
          const raw = parseYaml(fs.readFileSync(file, "utf8"));
          const onDef = raw?.on || raw?.true;
          if (!onDef) {
            continue;
          }
          const events: Record<string, any> = {};
          if (Array.isArray(onDef)) {
            for (const e of onDef) {
              events[e] = {};
            }
          } else if (typeof onDef === "string") {
            events[onDef] = {};
          } else {
            Object.assign(events, onDef);
          }
          if (isWorkflowRelevant({ events }, branch, changedFiles)) {
            relevant.push(file);
          }
        } catch {
          // Skip unparsable workflows
        }
      }

      if (relevant.length === 0) {
        console.log(`[Agent CI] No relevant workflows found for branch '${branch}'.`);
        process.exit(0);
      }

      const results = await runWorkflows({ workflowPaths: relevant, sha, pauseOnFailure });
      printSummary(results);
      const anyFailed = results.some((r) => !r.succeeded);
      process.exit(anyFailed ? 1 : 0);
    }

    if (!workflow) {
      console.error("[Agent CI] Error: You must specify --workflow <path> or --all");
      console.log("");
      printUsage();
      process.exit(1);
    }

    // Resolve workflow path before calling runWorkflows
    let workflowPath: string;
    if (path.isAbsolute(workflow)) {
      workflowPath = workflow;
    } else {
      const cwd = process.cwd();
      const repoRootFallback = resolveRepoRoot();
      const workflowsDir = path.resolve(repoRootFallback, ".github", "workflows");
      const pathsToTry = [
        path.resolve(cwd, workflow),
        path.resolve(repoRootFallback, workflow),
        path.resolve(workflowsDir, workflow),
      ];
      workflowPath = pathsToTry.find((p) => fs.existsSync(p)) || pathsToTry[1];
    }

    const results = await runWorkflows({ workflowPaths: [workflowPath], sha, pauseOnFailure });
    printSummary(results);
    if (results.some((r) => !r.succeeded)) {
      process.exit(1);
    }
    process.exit(0);
  } else if (command === "retry" || command === "abort") {
    let runnerName: string | undefined;
    let fromStep: string | undefined;
    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "--name" || args[i] === "-n" || args[i] === "--runner") && args[i + 1]) {
        runnerName = args[i + 1];
        i++;
      } else if (args[i] === "--from-step" && args[i + 1]) {
        fromStep = args[i + 1];
        i++;
      } else if (args[i] === "--from-start") {
        fromStep = "*";
      }
    }
    if (!runnerName) {
      console.error(`[Agent CI] Error: --name <name> is required for '${command}'`);
      process.exit(1);
    }
    if (fromStep && fromStep !== "*" && (isNaN(Number(fromStep)) || Number(fromStep) < 1)) {
      console.error(`[Agent CI] Error: --from-step must be a positive step number`);
      process.exit(1);
    }
    const signalsDir = findSignalsDir(runnerName);
    if (!signalsDir) {
      console.error(
        `[Agent CI] Error: No runner '${runnerName}' found. It may have already exited.`,
      );
      process.exit(1);
    }
    const pausedFile = path.join(signalsDir, "paused");
    if (!fs.existsSync(pausedFile)) {
      fs.rmSync(signalsDir, { recursive: true, force: true });
      console.error(
        `[Agent CI] Error: Runner '${runnerName}' is not currently paused. It may have already exited.`,
      );
      process.exit(1);
    }
    try {
      const { execSync } = await import("node:child_process");
      const status = execSync(`docker inspect -f '{{.State.Running}}' ${runnerName} 2>/dev/null`, {
        encoding: "utf-8",
      }).trim();
      if (status !== "true") {
        throw new Error("not running");
      }
    } catch {
      fs.rmSync(signalsDir, { recursive: true, force: true });
      console.error(`[Agent CI] Error: Runner '${runnerName}' is no longer running.`);
      process.exit(1);
    }
    if (command === "retry") {
      const runDir = path.dirname(signalsDir);
      syncWorkspaceForRetry(runDir);
      if (fromStep) {
        fs.writeFileSync(path.join(signalsDir, "from-step"), fromStep);
      }
    }
    fs.writeFileSync(path.join(signalsDir, command), "");
    const extra = fromStep ? ` (from step ${fromStep === "*" ? "1" : fromStep})` : "";
    console.log(`[Agent CI] Sent '${command}' signal to ${runnerName}${extra}`);
    process.exit(0);
  } else {
    printUsage();
    process.exit(1);
  }
}

// ─── runWorkflows ──────────────────────────────────────────────────────────────
// Single entry point for both `--workflow` and `--all`.
// One workflow = --all with a single entry.

async function runWorkflows(options: {
  workflowPaths: string[];
  sha?: string;
  pauseOnFailure: boolean;
}): Promise<JobResult[]> {
  const { workflowPaths, sha, pauseOnFailure } = options;

  // Create the run state store — single source of truth for all progress
  const runId = `run-${Date.now()}`;
  const storeFilePath = path.join(getWorkingDirectory(), "runs", runId, "run-state.json");
  const store = new RunStateStore(runId, storeFilePath);

  // Start the render loop — reads from store, never touches execution logic
  // In agent mode (AI_AGENT=1 or --quiet), skip animated rendering to avoid token waste
  // but register a synchronous callback for important state changes.
  let renderInterval: ReturnType<typeof setInterval> | null = null;
  if (isAgentMode()) {
    const reportedPauses = new Set<string>();
    const reportedRunners = new Set<string>();
    const reportedSteps = new Map<string, Set<string>>();
    const emit = (msg: string) => process.stderr.write(msg + "\n");
    store.onUpdate((state) => {
      for (const wf of state.workflows) {
        for (const job of wf.jobs) {
          if (job.status !== "queued" && !reportedRunners.has(job.runnerId)) {
            reportedRunners.add(job.runnerId);
            emit(`[Agent CI] Starting runner ${job.runnerId} (${wf.id} > ${job.id})`);
            if (job.logDir) {
              emit(`  Logs: ${job.logDir}`);
            }
          }
          if (!reportedSteps.has(job.runnerId)) {
            reportedSteps.set(job.runnerId, new Set());
          }
          const seen = reportedSteps.get(job.runnerId)!;
          for (const step of job.steps) {
            const key = `${step.index}:${step.status}`;
            if (seen.has(key)) {
              continue;
            }
            if (step.status === "completed") {
              seen.add(key);
              const dur =
                step.durationMs != null ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : "";
              emit(`  ✓ ${step.name}${dur}`);
            } else if (step.status === "failed") {
              seen.add(key);
              emit(`  ✗ ${step.name}`);
            } else if (step.status === "running") {
              seen.add(key);
              emit(`  ▸ ${step.name}`);
            }
          }
          if (job.status === "paused" && !reportedPauses.has(job.runnerId)) {
            reportedPauses.add(job.runnerId);
            const lines: string[] = [];
            lines.push(`\n[Agent CI] Step failed: "${job.pausedAtStep}" (${wf.id} > ${job.id})`);
            if (job.attempt && job.attempt > 1) {
              lines.push(`  Attempt: ${job.attempt}`);
            }
            if (job.lastOutputLines && job.lastOutputLines.length > 0) {
              lines.push("  Last output:");
              for (const l of job.lastOutputLines) {
                lines.push(`    ${l}`);
              }
            }
            lines.push(`  To retry:  agent-ci retry --name ${job.runnerId}`);
            emit(lines.join("\n"));
          } else if (job.status !== "paused" && reportedPauses.has(job.runnerId)) {
            reportedPauses.delete(job.runnerId);
          }
        }
      }
    });
  } else {
    renderInterval = setInterval(() => {
      const state = store.getState();
      if (state.workflows.length > 0) {
        logUpdate(renderRunState(state));
      }
    }, 80);
  }

  try {
    const allResults: JobResult[] = [];

    if (workflowPaths.length === 1) {
      // Single workflow — no cross-workflow warm-cache serialization needed
      const results = await handleWorkflow({
        workflowPath: workflowPaths[0],
        sha,
        pauseOnFailure,
        store,
      });
      allResults.push(...results);
    } else {
      // Multiple workflows (--all mode)
      // Determine warm-cache status from the first workflow's repo root
      const firstRepoRoot = resolveRepoRootFromWorkflow(workflowPaths[0]);
      const repoSlug = resolveRepoInfo(firstRepoRoot).replace("/", "-");
      let lockfileHash = "no-lockfile";
      try {
        lockfileHash = computeLockfileHash(firstRepoRoot);
      } catch {}
      const warmModulesDir = path.resolve(
        getWorkingDirectory(),
        "cache",
        "warm-modules",
        repoSlug,
        lockfileHash,
      );
      const warm = isWarmNodeModules(warmModulesDir);

      if (!warm && workflowPaths.length > 1) {
        // Cold cache — run first workflow serially to populate warm modules,
        // then launch the rest in parallel.
        const firstResults = await handleWorkflow({
          workflowPath: workflowPaths[0],
          sha,
          pauseOnFailure,
          store,
        });
        allResults.push(...firstResults);

        const settled = await Promise.allSettled(
          workflowPaths
            .slice(1)
            .map((wf) => handleWorkflow({ workflowPath: wf, sha, pauseOnFailure, store })),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") {
            allResults.push(...s.value);
          }
        }
      } else {
        const settled = await Promise.allSettled(
          workflowPaths.map((wf) =>
            handleWorkflow({ workflowPath: wf, sha, pauseOnFailure, store }),
          ),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") {
            allResults.push(...s.value);
          }
        }
      }
    }

    store.complete(allResults.some((r) => !r.succeeded) ? "failed" : "completed");
    return allResults;
  } finally {
    if (renderInterval) {
      clearInterval(renderInterval);
    }
    if (!isAgentMode()) {
      // Final render — show the completed state
      const finalState = store.getState();
      if (finalState.workflows.length > 0) {
        logUpdate(renderRunState(finalState));
      }
      logUpdate.done();
    }
  }
}

// ─── handleWorkflow ───────────────────────────────────────────────────────────
// Processes a single workflow file: parses jobs, handles matrix expansion,
// wave scheduling, warm-cache serialization, and concurrency limiting.

async function handleWorkflow(options: {
  workflowPath: string;
  sha?: string;
  pauseOnFailure: boolean;
  store: RunStateStore;
}): Promise<JobResult[]> {
  const { sha, pauseOnFailure, store } = options;
  let workflowPath = options.workflowPath;

  try {
    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Workflow file not found: ${workflowPath}`);
    }

    const repoRoot = resolveRepoRootFromWorkflow(workflowPath);

    if (!process.env.AGENT_CI_WORKING_DIR) {
      setWorkingDirectory(DEFAULT_WORKING_DIR);
    }

    const { headSha, shaRef } = sha
      ? resolveHeadSha(repoRoot, sha)
      : { headSha: undefined, shaRef: undefined };
    const githubRepo = resolveRepoInfo(repoRoot);
    const [owner, name] = githubRepo.split("/");

    const template = await getWorkflowTemplate(workflowPath);
    const jobs = template.jobs.filter((j) => j.type === "job");

    if (jobs.length === 0) {
      debugCli(`[Agent CI] No jobs found in workflow: ${path.basename(workflowPath)}`);
      return [];
    }

    // ── Collect expanded jobs (with matrix expansion) ─────────────────────────
    type ExpandedJob = {
      workflowPath: string;
      taskName: string;
      matrixContext?: Record<string, string>;
    };

    const expandedJobs: ExpandedJob[] = [];

    for (const job of jobs) {
      const id = job.id.toString();
      const matrixDef = await parseMatrixDef(workflowPath, id);
      if (matrixDef) {
        const combos = expandMatrixCombinations(matrixDef);
        const total = combos.length;
        for (let ci = 0; ci < combos.length; ci++) {
          expandedJobs.push({
            workflowPath,
            taskName: id,
            matrixContext: {
              ...combos[ci],
              __job_total: String(total),
              __job_index: String(ci),
            },
          });
        }
      } else {
        expandedJobs.push({ workflowPath, taskName: id });
      }
    }

    // For single-job workflows, run directly without extra orchestration
    if (expandedJobs.length === 1) {
      const ej = expandedJobs[0];
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
      validateSecrets(workflowPath, ej.taskName, secrets, secretsFilePath);

      const steps = await parseWorkflowSteps(workflowPath, ej.taskName, secrets, ej.matrixContext);
      const services = await parseWorkflowServices(workflowPath, ej.taskName);
      const container = await parseWorkflowContainer(workflowPath, ej.taskName);

      const job: Job = {
        deliveryId: `run-${Date.now()}`,
        eventType: "workflow_job",
        githubJobId: `local-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
        githubRepo: githubRepo,
        githubToken: "mock_token",
        headSha: headSha,
        shaRef: shaRef,
        env: { AGENT_CI_LOCAL: "true" },
        repository: {
          name: name,
          full_name: githubRepo,
          owner: { login: owner },
          default_branch: "main",
        },
        steps,
        services,
        container: container ?? undefined,
        workflowPath,
        taskId: ej.taskName,
      };

      const result = await executeLocalJob(job, { pauseOnFailure, store });
      return [result];
    }

    // ── Multi-job orchestration ────────────────────────────────────────────────
    const maxJobs = getDefaultMaxConcurrentJobs();

    // ── Warm-cache check ───────────────────────────────────────────────────────
    const repoSlug = githubRepo.replace("/", "-");
    let lockfileHash = "no-lockfile";
    try {
      lockfileHash = computeLockfileHash(repoRoot);
    } catch {}
    const warmModulesDir = path.resolve(
      getWorkingDirectory(),
      "cache",
      "warm-modules",
      repoSlug,
      lockfileHash,
    );
    let warm = isWarmNodeModules(warmModulesDir);

    // Naming convention: agent-ci-<N>[-j<idx>][-m<shardIdx>]
    const baseRunNum = getNextLogNum("agent-ci");
    let globalIdx = 0;

    const buildJob = (ej: ExpandedJob): Job => {
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
      validateSecrets(workflowPath, ej.taskName, secrets, secretsFilePath);

      const idx = globalIdx++;
      let suffix = `-j${idx + 1}`;
      if (ej.matrixContext) {
        const shardIdx = parseInt(ej.matrixContext.__job_index ?? "0", 10) + 1;
        suffix += `-m${shardIdx}`;
      }
      const derivedRunnerName = `agent-ci-${baseRunNum}${suffix}`;

      return {
        deliveryId: `run-${Date.now()}`,
        eventType: "workflow_job",
        githubJobId: Math.floor(Math.random() * 1000000).toString(),
        githubRepo: githubRepo,
        githubToken: "mock_token",
        headSha: headSha,
        shaRef: shaRef,
        env: { AGENT_CI_LOCAL: "true" },
        repository: {
          name: name,
          full_name: githubRepo,
          owner: { login: owner },
          default_branch: "main",
        },
        runnerName: derivedRunnerName,
        steps: undefined as any,
        services: undefined as any,
        container: undefined,
        workflowPath,
        taskId: ej.taskName,
      };
    };

    const runJob = async (
      ej: ExpandedJob,
      needsContext?: Record<string, Record<string, string>>,
    ): Promise<JobResult> => {
      const { taskName, matrixContext } = ej;
      debugCli(
        `Running: ${path.basename(workflowPath)} | Task: ${taskName}${matrixContext ? ` | Matrix: ${JSON.stringify(Object.fromEntries(Object.entries(matrixContext).filter(([k]) => !k.startsWith("__"))))}` : ""}`,
      );
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
      validateSecrets(workflowPath, taskName, secrets, secretsFilePath);
      const steps = await parseWorkflowSteps(
        workflowPath,
        taskName,
        secrets,
        matrixContext,
        needsContext,
      );
      const services = await parseWorkflowServices(workflowPath, taskName);
      const container = await parseWorkflowContainer(workflowPath, taskName);

      const job = buildJob(ej);
      job.steps = steps;
      job.services = services;
      job.container = container ?? undefined;

      const result = await executeLocalJob(job, { pauseOnFailure, store });

      // result.outputs now contains raw step outputs (extracted inside executeLocalJob
      // before workspace cleanup). Resolve them to job-level outputs using the
      // output definitions from the workflow YAML.
      if (result.outputs && Object.keys(result.outputs).length > 0) {
        const outputDefs = parseJobOutputDefs(workflowPath, taskName);
        if (Object.keys(outputDefs).length > 0) {
          result.outputs = resolveJobOutputs(outputDefs, result.outputs);
        }
      }

      return result;
    };

    pruneOrphanedDockerResources();

    const limiter = createConcurrencyLimiter(maxJobs);
    const allResults: JobResult[] = [];
    // Accumulate job outputs across waves for needs.*.outputs.* resolution
    const jobOutputs = new Map<string, Record<string, string>>();

    // ── Dependency-aware wave scheduling ──────────────────────────────────────
    const deps = parseJobDependencies(workflowPath);
    const waves = topoSort(deps);

    const taskNamesInWf = new Set(expandedJobs.map((j) => j.taskName));
    const filteredWaves = waves
      .map((wave) => wave.filter((jobId) => taskNamesInWf.has(jobId)))
      .filter((wave) => wave.length > 0);

    if (filteredWaves.length === 0) {
      filteredWaves.push(Array.from(taskNamesInWf));
    }

    /** Build a needsContext for a job from its dependencies' accumulated outputs */
    const buildNeedsContext = (
      jobId: string,
    ): Record<string, Record<string, string>> | undefined => {
      const jobDeps = deps.get(jobId);
      if (!jobDeps || jobDeps.length === 0) {
        return undefined;
      }
      const ctx: Record<string, Record<string, string>> = {};
      for (const depId of jobDeps) {
        ctx[depId] = jobOutputs.get(depId) ?? {};
      }
      return ctx;
    };

    /** Collect outputs from a completed job result */
    const collectOutputs = (result: JobResult, taskName: string) => {
      if (result.outputs && Object.keys(result.outputs).length > 0) {
        jobOutputs.set(taskName, result.outputs);
      }
    };

    // Track job results for if-condition evaluation (success/failure status)
    const jobResultStatus = new Map<string, string>();

    /** Check if a job should be skipped based on its if: condition */
    const shouldSkipJob = (jobId: string): boolean => {
      const ifExpr = parseJobIf(workflowPath, jobId);
      if (ifExpr === null) {
        // No if: condition — default behavior is success() (skip if any upstream failed)
        const jobDeps = deps.get(jobId);
        if (jobDeps && jobDeps.length > 0) {
          const anyFailed = jobDeps.some((d) => jobResultStatus.get(d) === "failure");
          if (anyFailed) {
            return true;
          }
        }
        return false;
      }
      // Build upstream job results for the evaluator
      const upstreamResults: Record<string, string> = {};
      const jobDeps = deps.get(jobId) ?? [];
      for (const depId of jobDeps) {
        upstreamResults[depId] = jobResultStatus.get(depId) ?? "success";
      }
      const needsCtx = buildNeedsContext(jobId);
      return !evaluateJobIf(ifExpr, upstreamResults, needsCtx);
    };

    /** Create a synthetic skipped result for a job that was skipped by if: */
    const skippedResult = (ej: ExpandedJob): JobResult => ({
      name: `agent-ci-skipped-${ej.taskName}`,
      workflow: path.basename(workflowPath),
      taskId: ej.taskName,
      succeeded: true,
      durationMs: 0,
      debugLogPath: "",
      steps: [],
    });

    /** Run a job or skip it based on if: condition */
    const runOrSkipJob = async (ej: ExpandedJob): Promise<JobResult> => {
      if (shouldSkipJob(ej.taskName)) {
        debugCli(`Skipping ${ej.taskName} (if: condition is false)`);
        const result = skippedResult(ej);
        jobResultStatus.set(ej.taskName, "skipped");
        return result;
      }
      const ctx = buildNeedsContext(ej.taskName);
      const result = await runJob(ej, ctx);
      jobResultStatus.set(ej.taskName, result.succeeded ? "success" : "failure");
      collectOutputs(result, ej.taskName);
      return result;
    };

    for (let wi = 0; wi < filteredWaves.length; wi++) {
      const waveJobIds = new Set(filteredWaves[wi]);
      const waveJobs = expandedJobs.filter((j) => waveJobIds.has(j.taskName));

      if (waveJobs.length === 0) {
        continue;
      }

      // ── Warm-cache serialization for the first wave ────────────────────────
      if (!warm && wi === 0 && waveJobs.length > 1) {
        debugCli("Cold cache — running first job to populate warm modules...");
        const firstResult = await runOrSkipJob(waveJobs[0]);
        allResults.push(firstResult);

        const results = await Promise.allSettled(
          waveJobs.slice(1).map((ej) => limiter.run(() => runOrSkipJob(ej))),
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            allResults.push(r.value);
          }
        }
        warm = true;
      } else {
        const results = await Promise.allSettled(
          waveJobs.map((ej) => limiter.run(() => runOrSkipJob(ej))),
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            allResults.push(r.value);
          }
        }
      }

      // Check whether to abort remaining waves on failure
      const waveHadFailures = allResults.some((r) => !r.succeeded);
      if (waveHadFailures && wi < filteredWaves.length - 1) {
        // Check fail-fast setting for jobs in this wave
        const waveFailFastSettings = waveJobs.map((ej) => parseFailFast(workflowPath, ej.taskName));
        // Abort unless ALL jobs in the wave explicitly set fail-fast: false
        const shouldAbort = !waveFailFastSettings.every((ff) => ff === false);
        if (shouldAbort) {
          debugCli(
            `Wave ${wi + 1} had failures — aborting remaining waves for ${path.basename(workflowPath)}`,
          );
          break;
        } else {
          debugCli(`Wave ${wi + 1} had failures but fail-fast is disabled — continuing`);
        }
      }
    }

    return allResults;
  } catch (error) {
    console.error(`[Agent CI] Failed to trigger run: ${(error as Error).message}`);
    return [];
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function printUsage() {
  console.log("Usage: agent-ci <command> [args]");
  console.log("");
  console.log("Commands:");
  console.log("  run [sha] --workflow <path>   Run all jobs in a workflow file (defaults to HEAD)");
  console.log(
    "  run --all                     Run all relevant PR/Push workflows for current branch",
  );
  console.log("  retry --name <name>           Send retry signal to a paused runner");
  console.log("    --from-step <N>              Re-run from step N (skips earlier steps)");
  console.log("    --from-start                 Re-run all run: steps from the beginning");
  console.log("  abort --name <name>           Send abort signal to a paused runner");
  console.log("");
  console.log("Options:");
  console.log("  -w, --workflow <path>         Path to the workflow file");
  console.log("  -a, --all                     Discover and run all relevant workflows");
  console.log("  -p, --pause-on-failure         Pause on step failure for interactive debugging");
  console.log(
    "  -q, --quiet                   Suppress animated rendering (also enabled by AI_AGENT=1)",
  );
}

function resolveRepoRoot() {
  let repoRoot = process.cwd();
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? process.cwd() : repoRoot;
}

function resolveRepoRootFromWorkflow(workflowPath: string): string {
  let repoRoot = path.dirname(workflowPath);
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? resolveRepoRoot() : repoRoot;
}

function resolveRepoInfo(repoRoot: string) {
  let githubRepo = config.GITHUB_REPO;
  try {
    const remoteUrl = execSync("git remote get-url origin", { cwd: repoRoot }).toString().trim();
    const match = remoteUrl.match(/[:/]([^/]+\/[^/]+)\.git$/);
    if (match) {
      githubRepo = match[1];
    }
  } catch {
    debugCli("Could not detect remote 'origin', using config default.");
  }
  return githubRepo;
}

function resolveHeadSha(repoRoot: string, sha: string) {
  try {
    return {
      headSha: execSync(`git rev-parse ${sha}`, { cwd: repoRoot }).toString().trim(),
      shaRef: sha,
    };
  } catch {
    throw new Error(`Failed to resolve ref: ${sha}`);
  }
}

run().catch((err) => {
  console.error("[Agent CI] Fatal error:", err);
  process.exit(1);
});
