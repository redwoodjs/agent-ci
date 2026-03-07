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
} from "./workflow/workflow-parser.js";
import { Job } from "./types.js";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./output/concurrency.js";
import { isWarmNodeModules, computeLockfileHash } from "./output/cleanup.js";
import { getWorkingDirectory } from "./output/working-directory.js";
import { pruneOrphanedDockerResources } from "./docker/shutdown.js";
import { parseJobDependencies, topoSort } from "./workflow/job-scheduler.js";
import {
  printJobStatus,
  printJobStarted,
  printSummary,
  type JobResult,
} from "./output/reporter.js";

async function run() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "run") {
    // Basic argument parsing
    let sha: string | undefined;
    let workflow: string | undefined;

    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "--workflow" || args[i] === "-w") && args[i + 1]) {
        workflow = args[i + 1];
        i++;
      } else if (!args[i].startsWith("-")) {
        sha = args[i];
      }
    }

    let workingDir = process.env.MACHINEN_WORKING_DIR;
    if (workingDir) {
      if (!path.isAbsolute(workingDir)) {
        workingDir = path.resolve(PROJECT_ROOT, workingDir);
      }
      setWorkingDirectory(workingDir);
    }

    if (!workflow) {
      console.error("[Machinen] Error: You must specify --workflow <path>");
      console.log("");
      printUsage();
      process.exit(1);
    }

    await handleRun({ sha, workflow });

    process.exit(0);
  } else {
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log("Usage: machinen <command> [args]");
  console.log("");
  console.log("Commands:");
  console.log("  run [sha] --workflow <path>: Run all jobs in a workflow file (defaults to HEAD)");
  console.log("");
  console.log("Options:");
  console.log("  -w, --workflow <path>  Path to the workflow file");
}

function resolveRepoRoot() {
  let repoRoot = process.cwd();
  while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
    repoRoot = path.dirname(repoRoot);
  }
  return repoRoot === "/" ? process.cwd() : repoRoot;
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

async function handleRun(options: { sha?: string; workflow?: string }) {
  const { sha } = options;
  let workflow = options.workflow;

  try {
    // Resolve the workflow path first so we can derive the correct repo root.
    let workflowPath: string;
    if (!workflow) {
      throw new Error("Workflow path is required");
    }
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

    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Workflow file not found: ${workflowPath}`);
    }

    // Derive the repo root by walking UP from the workflow file's directory.
    // This correctly resolves external repos (e.g. sdk) even when the CLI
    // CWD is inside machinen.
    let repoRoot = path.dirname(workflowPath);
    while (repoRoot !== "/" && !fs.existsSync(path.join(repoRoot, ".git"))) {
      repoRoot = path.dirname(repoRoot);
    }
    if (repoRoot === "/") {
      // Fallback: use process.cwd()-based resolution
      repoRoot = resolveRepoRoot();
    }

    // Scope the working directory to an OS temp folder unless the
    // user explicitly configured one via MACHINEN_WORKING_DIR environment variable.
    if (!process.env.MACHINEN_WORKING_DIR) {
      setWorkingDirectory(DEFAULT_WORKING_DIR);
    }

    const { headSha, shaRef } = sha
      ? resolveHeadSha(repoRoot, sha)
      : { headSha: undefined, shaRef: undefined };
    const githubRepo = resolveRepoInfo(repoRoot);
    const [owner, name] = githubRepo.split("/");

    // Parse the workflow template and collect all jobs
    const template = await getWorkflowTemplate(workflowPath);
    const jobs = template.jobs.filter((j) => j.type === "job");

    if (jobs.length === 0) {
      console.log("[Machinen] No jobs found in workflow.");
      return;
    }

    // ── Collect expanded jobs (with matrix expansion) ──────────────────────────
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
      const secretsFilePath = path.join(repoRoot, ".env.machinen");
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
        env: {
          MACHINEN_LOCAL: "true",
        },
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

      printJobStarted(path.basename(workflowPath), ej.taskName);
      const result = await executeLocalJob(job);
      printSummary([result]);
      if (!result.succeeded) {
        process.exit(1);
      }
      return;
    }

    // ── Multi-job orchestration ───────────────────────────────────────────────
    const maxJobs = getDefaultMaxConcurrentJobs();
    console.log(
      `[Machinen] Found ${expandedJobs.length} runner(s) to launch (concurrency: ${maxJobs}).`,
    );

    // ── Warm-cache check ──────────────────────────────────────────────────────
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

    // Naming convention: machinen-<N>[-j<idx>][-m<shardIdx>]
    const baseRunNum = getNextLogNum("machinen");
    let globalIdx = 0;

    const buildJob = (ej: ExpandedJob): Job => {
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.machinen");
      validateSecrets(workflowPath, ej.taskName, secrets, secretsFilePath);

      const idx = globalIdx++;
      let suffix = "";
      suffix += `-j${idx + 1}`;
      if (ej.matrixContext) {
        const shardIdx = parseInt(ej.matrixContext.__job_index ?? "0", 10) + 1;
        suffix += `-m${shardIdx}`;
      }
      const derivedRunnerName = `machinen-${baseRunNum}${suffix}`;

      return {
        deliveryId: `run-${Date.now()}`,
        eventType: "workflow_job",
        githubJobId: Math.floor(Math.random() * 1000000).toString(),
        githubRepo: githubRepo,
        githubToken: "mock_token",
        headSha: headSha,
        shaRef: shaRef,
        env: {
          MACHINEN_LOCAL: "true",
        },
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
      };
    };

    const runJob = async (ej: ExpandedJob): Promise<JobResult> => {
      const { taskName, matrixContext } = ej;
      debugCli(
        `Running: ${path.basename(workflowPath)} | Task: ${taskName}${matrixContext ? ` | Matrix: ${JSON.stringify(Object.fromEntries(Object.entries(matrixContext).filter(([k]) => !k.startsWith("__"))))}` : ""}`,
      );
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.machinen");
      validateSecrets(workflowPath, taskName, secrets, secretsFilePath);
      const steps = await parseWorkflowSteps(workflowPath, taskName, secrets, matrixContext);
      const services = await parseWorkflowServices(workflowPath, taskName);
      const container = await parseWorkflowContainer(workflowPath, taskName);

      const job = buildJob(ej);
      job.steps = steps;
      job.services = services;
      job.container = container ?? undefined;

      printJobStarted(path.basename(workflowPath), taskName);
      const result = await executeLocalJob(job);
      printJobStatus(result);
      return result;
    };

    // ── Prune orphaned Docker resources before launching ────────────────────
    pruneOrphanedDockerResources();

    const limiter = createConcurrencyLimiter(maxJobs);
    const allResults: JobResult[] = [];

    // ── Dependency-aware wave scheduling ─────────────────────────────────────
    const deps = parseJobDependencies(workflowPath);
    const waves = topoSort(deps);

    const taskNamesInWf = new Set(expandedJobs.map((j) => j.taskName));
    const filteredWaves = waves
      .map((wave) => wave.filter((jobId) => taskNamesInWf.has(jobId)))
      .filter((wave) => wave.length > 0);

    if (filteredWaves.length === 0) {
      // No dependency structure — run all jobs as one wave
      filteredWaves.push(Array.from(taskNamesInWf));
    }

    for (let wi = 0; wi < filteredWaves.length; wi++) {
      const waveJobIds = new Set(filteredWaves[wi]);
      const waveJobs = expandedJobs.filter((j) => waveJobIds.has(j.taskName));

      if (waveJobs.length === 0) {
        continue;
      }

      if (filteredWaves.length > 1) {
        console.log(
          `[Machinen] Wave ${wi + 1}/${filteredWaves.length}: [${filteredWaves[wi].join(", ")}]`,
        );
      }

      // ── Warm-cache serialization for the first wave ─────────────────────
      if (!warm && wi === 0 && waveJobs.length > 1) {
        debugCli("Cold cache — running first job to populate warm modules...");
        const firstResult = await runJob(waveJobs[0]);
        allResults.push(firstResult);

        const rest = waveJobs.slice(1);
        const results = await Promise.allSettled(rest.map((ej) => limiter.run(() => runJob(ej))));
        for (const r of results) {
          if (r.status === "fulfilled") {
            allResults.push(r.value);
          }
        }
        // Mark cache as warm for subsequent waves
        warm = true;
      } else {
        const results = await Promise.allSettled(
          waveJobs.map((ej) => limiter.run(() => runJob(ej))),
        );
        for (const r of results) {
          if (r.status === "fulfilled") {
            allResults.push(r.value);
          }
        }
      }

      // If any job in this wave failed, abort remaining waves
      const waveHadFailures = allResults.some((r) => !r.succeeded);
      if (waveHadFailures && wi < filteredWaves.length - 1) {
        console.error(
          `[Machinen] Wave ${wi + 1} had failures — aborting remaining waves for ${path.basename(workflowPath)}`,
        );
        break;
      }
    }

    // ── Print failures-first summary ────────────────────────────────────────
    printSummary(allResults);

    const totalFailures = allResults.filter((r) => !r.succeeded).length;
    if (totalFailures > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`[Machinen] Failed to trigger run: ${(error as Error).message}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[Machinen] Fatal error:", err);
  process.exit(1);
});
