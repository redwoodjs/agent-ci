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
  isWorkflowRelevant,
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
    let taskName: string | undefined;
    let runAll = false;
    let branch: string | undefined;
    let runnerName: string | undefined;
    let matrixJson: string | undefined;
    let concurrency: number | undefined;

    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "--workflow" || args[i] === "-w") && args[i + 1]) {
        workflow = args[i + 1];
        i++;
      } else if (
        (args[i] === "--task" || args[i] === "-t" || args[i] === "--job" || args[i] === "-j") &&
        args[i + 1]
      ) {
        taskName = args[i + 1];
        i++;
      } else if (args[i] === "--all" || args[i] === "-a") {
        runAll = true;
      } else if (args[i] === "--branch" && args[i + 1]) {
        branch = args[i + 1];
        i++;
      } else if (args[i] === "--runner-name" && args[i + 1]) {
        runnerName = args[i + 1];
        i++;
      } else if (args[i] === "--matrix" && args[i + 1]) {
        matrixJson = args[i + 1];
        i++;
      } else if ((args[i] === "--concurrency" || args[i] === "-c") && args[i + 1]) {
        concurrency = parseInt(args[i + 1], 10);
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

    if (!runAll && !workflow) {
      console.error("[Machinen] Error: You must specify either --workflow <path> or --all");
      console.log("");
      printUsage();
      process.exit(1);
    }

    if (runAll) {
      const maxJobs = concurrency ?? getDefaultMaxConcurrentJobs();
      await handleRunAll({ sha, branch, taskName, runnerName, concurrency: maxJobs });
    } else {
      await handleRun({ sha, workflow, taskName, runnerName, matrixJson });
    }

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
  console.log(
    "  run [sha] --workflow <path> [--task <name>]: Run a specific workflow (defaults to HEAD)",
  );
  console.log(
    "  run [sha] --all [--branch <name>] [--task <name>]: Run all relevant PR/Push workflows for the branch",
  );
  console.log("");
  console.log("Options:");
  console.log("  -w, --workflow <path>  Path to the workflow file");
  console.log("  -t, --task <name>      Specific task (job) to run");
  console.log("  -a, --all              Run all relevant workflows");
  console.log(
    "  --branch <name>        Branch name for relevance check (defaults to current branch)",
  );
  console.log("  -c, --concurrency <n>  Max parallel jobs (default: cpuCount/2)");
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

function getCurrentBranch(repoRoot: string) {
  try {
    return execSync("git branch --show-current", { cwd: repoRoot }).toString().trim();
  } catch {
    return "main";
  }
}

async function handleRun(options: {
  sha?: string;
  workflow?: string;
  taskName?: string;
  runnerName?: string;
  matrixJson?: string;
}) {
  const { sha, runnerName, matrixJson } = options;
  let workflow = options.workflow;
  let taskName = options.taskName;

  try {
    // Resolve the workflow path first so we can derive the correct repo root.
    let workflowPath: string;
    if (!workflow) {
      throw new Error("Workflow path is required when not using --all");
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

    // 5. Resolve Job
    const template = await getWorkflowTemplate(workflowPath);
    const jobs = template.jobs.filter((j) => j.type === "job");

    if (!taskName) {
      if (jobs.length === 1) {
        taskName = jobs[0].id.toString();
      } else {
        const jobIds = jobs.map((j) => j.id.toString());
        // Look for common entry point names
        const found = ["test", "ci", "run", "build"].find((name) => jobIds.includes(name));
        if (found) {
          taskName = found;
        } else {
          console.error(
            `[Machinen] Multiple tasks found in workflow. Please specify one with --task:`,
          );
          jobIds.forEach((id) => console.error(`  - ${id}`));
          process.exit(1);
        }
      }
    }

    // Double check specific job if provided
    const jobIds = jobs.map((j) => j.id.toString());
    if (!jobIds.includes(taskName)) {
      console.error(
        `[Machinen] Task "${taskName}" not found in ${path.basename(workflowPath)}. Available tasks:`,
      );
      jobIds.forEach((id) => console.error(`  - ${id}`));
      process.exit(1);
    }

    const secrets = loadMachineSecrets(repoRoot);
    const secretsFilePath = path.join(repoRoot, ".env.machinen");
    validateSecrets(workflowPath, taskName, secrets, secretsFilePath);

    // Parse matrix context if provided via --matrix flag
    let matrixContext: Record<string, string> | undefined;
    if (matrixJson) {
      try {
        matrixContext = JSON.parse(matrixJson);
      } catch {
        debugCli("Warning: --matrix value is not valid JSON, ignoring.");
      }
    }

    const steps = await parseWorkflowSteps(workflowPath, taskName, secrets, matrixContext);
    const services = await parseWorkflowServices(workflowPath, taskName);
    const container = await parseWorkflowContainer(workflowPath, taskName);

    // Derive runner name: machinen-<N> (single job convention)
    const derivedRunnerName = runnerName || undefined;

    // 6. Construct Job
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
      runnerName: derivedRunnerName,
      steps,
      services,
      container: container ?? undefined,
      workflowPath,
      taskId: taskName,
    };

    // 7. Execute
    printJobStarted(path.basename(workflowPath), taskName);
    const result = await executeLocalJob(job);
    printSummary([result]);
    if (!result.succeeded) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`[Machinen] Failed to trigger run: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function handleRunAll(options: {
  sha?: string;
  branch?: string;
  taskName?: string;
  runnerName?: string;
  concurrency?: number;
}) {
  debugCli("Scanning for relevant workflows...");

  try {
    const repoRoot = resolveRepoRoot();
    // Scope the working directory to an OS temp folder unless the
    // user explicitly configured one via MACHINEN_WORKING_DIR environment variable.
    if (!process.env.MACHINEN_WORKING_DIR) {
      setWorkingDirectory(DEFAULT_WORKING_DIR);
    }
    const { headSha, shaRef } = options.sha
      ? resolveHeadSha(repoRoot, options.sha)
      : { headSha: undefined, shaRef: undefined };
    const githubRepo = resolveRepoInfo(repoRoot);
    const [owner, name] = githubRepo.split("/");
    const branch = options.branch || getCurrentBranch(repoRoot);

    debugCli(`Repo: ${githubRepo} (Root: ${repoRoot}, Branch: ${branch})`);

    const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
    if (!fs.existsSync(workflowsDir)) {
      throw new Error(`Workflow directory not found: ${workflowsDir}`);
    }

    const yamlFiles = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

    // ── Collect expanded jobs grouped by workflow file ─────────────────────────
    type ExpandedJob = {
      workflowPath: string;
      taskName: string;
      matrixContext?: Record<string, string>;
    };
    // Group by workflow for dependency resolution (needs: is per-workflow)
    const jobsByWorkflow = new Map<string, ExpandedJob[]>();

    for (const file of yamlFiles) {
      const workflowPath = path.join(workflowsDir, file);
      const template = await getWorkflowTemplate(workflowPath);

      if (isWorkflowRelevant(template, branch)) {
        const jobs = template.jobs.filter((j) => j.type === "job");
        for (const job of jobs) {
          const id = job.id.toString();
          if (options.taskName && options.taskName !== id) {
            continue;
          }
          const matrixDef = await parseMatrixDef(workflowPath, id);
          const expandedForJob: ExpandedJob[] = [];
          if (matrixDef) {
            const combos = expandMatrixCombinations(matrixDef);
            const total = combos.length;
            for (let ci = 0; ci < combos.length; ci++) {
              expandedForJob.push({
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
            expandedForJob.push({ workflowPath, taskName: id });
          }
          const existing = jobsByWorkflow.get(workflowPath) ?? [];
          existing.push(...expandedForJob);
          jobsByWorkflow.set(workflowPath, existing);
        }
      }
    }

    // Flatten for total count
    const allExpandedJobs = Array.from(jobsByWorkflow.values()).flat();
    if (allExpandedJobs.length === 0) {
      console.log("[Machinen] No relevant workflows found for the current branch/triggers.");
      return;
    }

    const maxJobs = options.concurrency ?? getDefaultMaxConcurrentJobs();
    console.log(
      `[Machinen] Found ${allExpandedJobs.length} runner(s) to launch (concurrency: ${maxJobs}).`,
    );

    // ── Warm-cache check ────────────────────────────────────────────────────────
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
    const isMultiRunner = allExpandedJobs.length > 1;
    const baseRunNum = getNextLogNum("machinen");
    let globalIdx = 0;

    const buildJob = (ej: ExpandedJob): Job => {
      const { workflowPath, taskName, matrixContext } = ej;
      const secrets = loadMachineSecrets(repoRoot);
      const secretsFilePath = path.join(repoRoot, ".env.machinen");
      validateSecrets(workflowPath, taskName, secrets, secretsFilePath);

      const idx = globalIdx++;
      let derivedRunnerName = options.runnerName;
      if (!derivedRunnerName) {
        let suffix = "";
        if (isMultiRunner) {
          suffix += `-j${idx + 1}`;
        }
        if (matrixContext) {
          const shardIdx = parseInt(matrixContext.__job_index ?? "0", 10) + 1;
          suffix += `-m${shardIdx}`;
        }
        derivedRunnerName = `machinen-${baseRunNum}${suffix}`;
      }

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
      const { workflowPath, taskName, matrixContext } = ej;
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

    // ── Prune orphaned Docker resources before launching ──────────────────────
    pruneOrphanedDockerResources();

    const limiter = createConcurrencyLimiter(maxJobs);
    const allResults: JobResult[] = [];

    // ── Execute each workflow with dependency-aware wave scheduling ────────────
    for (const [workflowPath, wfJobs] of jobsByWorkflow) {
      // Resolve job dependencies (needs:) into waves
      const deps = parseJobDependencies(workflowPath);
      const waves = topoSort(deps);

      // Filter waves to only include jobs that are in our expanded set
      const taskNamesInWf = new Set(wfJobs.map((j) => j.taskName));
      const filteredWaves = waves
        .map((wave) => wave.filter((jobId) => taskNamesInWf.has(jobId)))
        .filter((wave) => wave.length > 0);

      if (filteredWaves.length === 0) {
        // No dependency structure — run all jobs from this workflow as one wave
        filteredWaves.push(Array.from(taskNamesInWf));
      }

      let waveHadFailures = false;
      for (let wi = 0; wi < filteredWaves.length; wi++) {
        const waveJobIds = new Set(filteredWaves[wi]);
        const waveJobs = wfJobs.filter((j) => waveJobIds.has(j.taskName));

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

        // If any job in this wave failed, abort remaining waves for this workflow
        waveHadFailures = allResults.some((r) => !r.succeeded);
        if (waveHadFailures && wi < filteredWaves.length - 1) {
          console.error(
            `[Machinen] Wave ${wi + 1} had failures — aborting remaining waves for ${path.basename(workflowPath)}`,
          );
          break;
        }
      }
    }

    // ── Print failures-first summary ──────────────────────────────────────────
    printSummary(allResults);

    const totalFailures = allResults.filter((r) => !r.succeeded).length;
    if (totalFailures > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`[Machinen] Failed to run all: ${(error as Error).message}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[Machinen] Fatal error:", err);
  process.exit(1);
});
