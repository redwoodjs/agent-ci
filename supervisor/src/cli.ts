import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { config, loadOaConfig } from "./config.js";
import { setWorkingDirectory, PROJECT_ROOT } from "./logger.js";

import { executeLocalJob } from "./local-job.js";
import { getWorkflowTemplate, parseWorkflowSteps, isWorkflowRelevant } from "./workflow-parser.js";
import { Job } from "./types.js";

async function run() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "server") {
    const { startServer } = await import("./server/index.js");
    startServer();
    return;
  }

  if (command === "run") {
    // Basic argument parsing
    let sha: string | undefined;
    let workflow: string | undefined;
    let taskName: string | undefined;
    let runAll = false;
    let branch: string | undefined;
    let configPath: string | undefined;
    let runnerName: string | undefined;

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
      } else if (args[i] === "--config" && args[i + 1]) {
        configPath = args[i + 1];
        i++;
      } else if (args[i] === "--runner-name" && args[i + 1]) {
        runnerName = args[i + 1];
        i++;
      } else if (!args[i].startsWith("-")) {
        sha = args[i];
      }
    }

    const parsedConfig = loadOaConfig(configPath);
    let workingDir = parsedConfig.workingDirectory;
    if (workingDir) {
      if (!path.isAbsolute(workingDir)) {
        workingDir = path.resolve(PROJECT_ROOT, workingDir);
      }
      setWorkingDirectory(workingDir);
    }

    if (!runAll && !workflow) {
      console.error("[OA] Error: You must specify either --workflow <path> or --all");
      console.log("");
      printUsage();
      process.exit(1);
    }

    if (runAll) {
      await handleRunAll({ sha, branch, taskName, runnerName });
    } else {
      await handleRun({ sha, workflow, taskName, runnerName });
    }
  } else {
    printUsage();
    process.exit(1);
  }
}

function printUsage() {
  console.log("Usage: oa <command> [args]");
  console.log("");
  console.log("Commands:");
  console.log("  server: Start the long-running continuous integration daemon for the UI");
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
  console.log("  --config <path>        Path to the shared JSONC configuration file");
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
    console.warn("[OA] Could not detect remote 'origin', using config default.");
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
}) {
  const { sha, runnerName } = options;
  let workflow = options.workflow;
  let taskName = options.taskName;

  try {
    const repoRoot = resolveRepoRoot();
    const { headSha, shaRef } = sha
      ? resolveHeadSha(repoRoot, sha)
      : { headSha: undefined, shaRef: undefined };
    const githubRepo = resolveRepoInfo(repoRoot);
    const [owner, name] = githubRepo.split("/");

    // 4. Resolve Workflow
    const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
    if (!workflow) {
      // This should be caught by the run() check now, but keeping for safety
      throw new Error("Workflow path is required when not using --all");
    }

    let workflowPath: string;
    if (path.isAbsolute(workflow)) {
      workflowPath = workflow;
    } else {
      // Try relative to cwd, then repoRoot, then workflowsDir
      const pathsToTry = [
        path.resolve(workflow),
        path.resolve(repoRoot, workflow),
        path.resolve(workflowsDir, workflow),
      ];
      workflowPath = pathsToTry.find((p) => fs.existsSync(p)) || pathsToTry[1]; // fallback to repoRoot relative
    }

    if (!fs.existsSync(workflowPath)) {
      throw new Error(`Workflow file not found: ${workflowPath}`);
    }

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
          console.error(`[OA] Multiple tasks found in workflow. Please specify one with --task:`);
          jobIds.forEach((id) => console.error(`  - ${id}`));
          process.exit(1);
        }
      }
    }

    // Double check specific job if provided
    const jobIds = jobs.map((j) => j.id.toString());
    if (!jobIds.includes(taskName)) {
      console.error(
        `[OA] Task "${taskName}" not found in ${path.basename(workflowPath)}. Available tasks:`,
      );
      jobIds.forEach((id) => console.error(`  - ${id}`));
      process.exit(1);
    }

    const steps = await parseWorkflowSteps(workflowPath, taskName);

    // 6. Construct Job
    const job: Job = {
      deliveryId: `local-run-${Date.now()}`,
      eventType: "workflow_job",
      githubJobId: "123",
      githubRepo: githubRepo,
      githubToken: "mock_token",
      headSha: headSha,
      shaRef: shaRef,
      env: {
        OA_LOCAL: "true",
      },
      repository: {
        name: name,
        full_name: githubRepo,
        owner: { login: owner },
        default_branch: "main",
      },
      runnerName,
      steps,
      workflowPath,
    };

    // 7. Execute
    await executeLocalJob(job);
  } catch (error) {
    console.error(`[OA] Failed to trigger run: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function handleRunAll(options: {
  sha?: string;
  branch?: string;
  taskName?: string;
  runnerName?: string;
}) {
  console.log("[OA] Scanning for relevant workflows...");

  try {
    const repoRoot = resolveRepoRoot();
    const { headSha, shaRef } = options.sha
      ? resolveHeadSha(repoRoot, options.sha)
      : { headSha: undefined, shaRef: undefined };
    const githubRepo = resolveRepoInfo(repoRoot);
    const [owner, name] = githubRepo.split("/");
    const branch = options.branch || getCurrentBranch(repoRoot);

    console.log(`[OA] Repo: ${githubRepo} (Root: ${repoRoot}, Branch: ${branch})`);

    const workflowsDir = path.resolve(repoRoot, ".github", "workflows");
    if (!fs.existsSync(workflowsDir)) {
      throw new Error(`Workflow directory not found: ${workflowsDir}`);
    }

    const yamlFiles = fs
      .readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    const relevantJobs: { workflowPath: string; taskName: string }[] = [];

    for (const file of yamlFiles) {
      const workflowPath = path.join(workflowsDir, file);
      const template = await getWorkflowTemplate(workflowPath);

      if (isWorkflowRelevant(template, branch)) {
        const jobs = template.jobs.filter((j) => j.type === "job");
        for (const job of jobs) {
          const id = job.id.toString();
          if (!options.taskName || options.taskName === id) {
            relevantJobs.push({ workflowPath, taskName: id });
          }
        }
      }
    }

    if (relevantJobs.length === 0) {
      console.log("[OA] No relevant workflows found for the current branch/triggers.");
      return;
    }

    console.log(`[OA] Found ${relevantJobs.length} relevant task(s) to run.`);

    for (const { workflowPath, taskName } of relevantJobs) {
      console.log(
        `[OA] --- Running Workflow: ${path.basename(workflowPath)} | Task: ${taskName} ---`,
      );
      const steps = await parseWorkflowSteps(workflowPath, taskName);

      const job: Job = {
        deliveryId: `local-run-${Date.now()}`,
        eventType: "workflow_job",
        githubJobId: Math.floor(Math.random() * 1000000).toString(),
        githubRepo: githubRepo,
        githubToken: "mock_token",
        headSha: headSha,
        shaRef: shaRef,
        env: {
          OA_LOCAL: "true",
        },
        repository: {
          name: name,
          full_name: githubRepo,
          owner: { login: owner },
          default_branch: "main",
        },
        runnerName: options.runnerName,
        steps,
        workflowPath,
      };

      await executeLocalJob(job);
    }
  } catch (error) {
    console.error(`[OA] Failed to run all: ${(error as Error).message}`);
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("[OA] Fatal error:", err);
  process.exit(1);
});
