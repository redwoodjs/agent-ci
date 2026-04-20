#!/usr/bin/env node
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import { config, loadMachineSecrets, resolveRepoSlug } from "./config.js";
import { getNextLogNum } from "./output/logger.js";
import {
  setWorkingDirectory,
  DEFAULT_WORKING_DIR,
  PROJECT_ROOT,
} from "./output/working-directory.js";
import { debugCli } from "./output/debug.js";

import type Docker from "dockerode";
import { executeLocalJob, getDocker } from "./runner/local-job.js";
import { executeMacosVmJob } from "./runner/macos-vm/macos-vm-job.js";
import { checkMacosVmHost } from "./runner/macos-vm/host-capability.js";
import {
  discoverRunnerImage,
  ensureRunnerImage,
  UPSTREAM_RUNNER_IMAGE,
} from "./runner/runner-image.js";
import {
  parseWorkflowSteps,
  parseWorkflowServices,
  parseWorkflowContainer,
  validateSecrets,
  extractSecretRefs,
  validateVars,
  extractVarRefs,
  parseMatrixDef,
  expandMatrixCombinations,
  collapseMatrixToSingle,
  isWorkflowRelevant,
  getChangedFiles,
  parseJobOutputDefs,
  parseJobIf,
  evaluateJobIf,
  parseFailFast,
  parseJobRunsOn,
  expandExpressions,
} from "./workflow/workflow-parser.js";
import {
  classifyRunsOn,
  isUnsupportedOS,
  formatUnsupportedOSWarning,
  type RunnerOSKind,
} from "./runner/runs-on-compat.js";
import { resolveJobOutputs } from "./runner/result-builder.js";
import { Job } from "./types.js";
import { createConcurrencyLimiter, getDefaultMaxConcurrentJobs } from "./output/concurrency.js";
import { isWarmNodeModules, computeLockfileHash } from "./output/cleanup.js";
import { getWorkingDirectory } from "./output/working-directory.js";
import {
  pruneOrphanedDockerResources,
  killOrphanedContainers,
  pruneStaleWorkspaces,
} from "./docker/shutdown.js";
import { topoSort } from "./workflow/job-scheduler.js";
import { expandReusableJobs } from "./workflow/reusable-workflow.js";
import { prefetchRemoteWorkflows } from "./workflow/remote-workflow-fetch.js";
import { printSummary, type JobResult } from "./output/reporter.js";
import { syncWorkspaceForRetry } from "./runner/sync.js";
import { computeDirtySha } from "./runner/dirty-sha.js";
import { RunStateStore } from "./output/run-state.js";
import { renderRunState } from "./output/state-renderer.js";
import { isAgentMode, setQuietMode } from "./output/agent-mode.js";
import { createDiffRenderer } from "./output/diff-renderer.js";
import { createFailedJobResult, wrapJobError, isJobError } from "./runner/job-result.js";
import { postCommitStatus } from "./commit-status.js";
import { writeRunResult } from "./run-result-writer.js";

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
    let noMatrix = false;
    let githubToken: string | undefined;
    let commitStatus = false;
    let maxJobs: number | undefined;
    const cliVars: Record<string, string> = {};

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
      } else if (args[i] === "--no-matrix") {
        noMatrix = true;
      } else if ((args[i] === "--jobs" || args[i] === "-j") && args[i + 1]) {
        maxJobs = parseInt(args[i + 1], 10);
        if (!Number.isFinite(maxJobs) || maxJobs < 1) {
          console.error("[Agent CI] Error: --jobs must be a positive integer");
          process.exit(1);
        }
        i++;
      } else if (args[i] === "--commit-status") {
        commitStatus = true;
      } else if (args[i] === "--var" && args[i + 1]) {
        const raw = args[i + 1];
        const eqIdx = raw.indexOf("=");
        if (eqIdx < 1) {
          console.error(`[Agent CI] Error: --var expects KEY=VALUE, got: ${raw}`);
          process.exit(1);
        }
        const key = raw.slice(0, eqIdx).trim();
        const value = raw.slice(eqIdx + 1);
        if (!key) {
          console.error(`[Agent CI] Error: --var expects KEY=VALUE, got: ${raw}`);
          process.exit(1);
        }
        cliVars[key] = value;
        i++;
      } else if (args[i] === "--github-token") {
        // If the next arg looks like a token value (not another flag), use it.
        // Otherwise, auto-resolve via `gh auth token`.
        if (args[i + 1] && !args[i + 1].startsWith("-")) {
          githubToken = args[i + 1];
          i++;
        } else {
          try {
            githubToken = execSync("gh auth token", {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            }).trim();
          } catch {
            console.error(
              "[Agent CI] Error: --github-token requires `gh` CLI to be installed and authenticated, or pass a token value: --github-token <value>",
            );
            process.exit(1);
          }
        }
      } else if (!args[i].startsWith("-")) {
        sha = args[i];
      }
    }

    // Also accept AGENT_CI_GITHUB_TOKEN env var (CLI flag takes precedence)
    if (!githubToken && process.env.AGENT_CI_GITHUB_TOKEN) {
      githubToken = process.env.AGENT_CI_GITHUB_TOKEN;
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

      const startedAt = new Date();
      const results = await runWorkflows({
        workflowPaths: relevant,
        sha,
        pauseOnFailure,
        noMatrix,
        githubToken,
        maxJobs,
        vars: cliVars,
      });
      if (results.length > 0) {
        printSummary(results);
      }
      if (commitStatus) {
        postCommitStatus(results, sha, githubToken);
      }
      persistRunResult({ results, repoRoot, startedAt, sha, branch });
      const anyFailed = results.length === 0 || results.some((r) => !r.succeeded);
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
    const repoRootFallback = resolveRepoRoot();
    if (path.isAbsolute(workflow)) {
      workflowPath = workflow;
    } else {
      const cwd = process.cwd();
      const workflowsDir = path.resolve(repoRootFallback, ".github", "workflows");
      const pathsToTry = [
        path.resolve(cwd, workflow),
        path.resolve(repoRootFallback, workflow),
        path.resolve(workflowsDir, workflow),
      ];
      workflowPath = pathsToTry.find((p) => fs.existsSync(p)) || pathsToTry[1];
    }

    const startedAt = new Date();
    const results = await runWorkflows({
      workflowPaths: [workflowPath],
      sha,
      pauseOnFailure,
      noMatrix,
      githubToken,
      maxJobs,
      vars: cliVars,
    });
    if (results.length > 0) {
      printSummary(results);
    }
    if (commitStatus) {
      postCommitStatus(results, sha, githubToken);
    }
    persistRunResult({ results, repoRoot: repoRootFallback, startedAt, sha });
    if (results.length === 0 || results.some((r) => !r.succeeded)) {
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

// ─── prefetchRunnerImages ──────────────────────────────────────────────────
// Pull (and, if necessary, build) every runner image that the upcoming
// workflows will need — once, before any job starts. Without this, each
// parallel workflow independently races to pull/build the same image, which
// with `--all` means dozens of concurrent `docker pull` calls on a cold
// cache. The per-job calls in local-job.ts remain as a safety net and take
// the inspect() fast path since images are already warm.
async function prefetchRunnerImages(workflowPaths: string[]): Promise<void> {
  const docker = getDocker();

  // The upstream runner image is always needed: default mode uses it
  // directly, direct-container mode uses it to seed the runner binary.
  // Check whether it's already cached — if not, pull with visible progress
  // so first-time users understand what's happening instead of seeing a
  // frozen spinner. See https://github.com/redwoodjs/agent-ci/issues/242
  const pulls: Promise<unknown>[] = [pullUpstreamRunnerImage(docker)];

  // Additionally, each unique repo root may resolve to a custom runner
  // image (env override or Dockerfile). Build/pull each unique one.
  const seenRepos = new Set<string>();
  const seenImages = new Set<string>([UPSTREAM_RUNNER_IMAGE]);
  for (const wf of workflowPaths) {
    const repoRoot = resolveRepoRootFromWorkflow(wf);
    if (seenRepos.has(repoRoot)) {
      continue;
    }
    seenRepos.add(repoRoot);
    const resolved = discoverRunnerImage(repoRoot);
    if (seenImages.has(resolved.image)) {
      continue;
    }
    seenImages.add(resolved.image);
    pulls.push(ensureRunnerImage(docker, resolved));
  }

  try {
    await Promise.all(pulls);
  } catch (err) {
    // Surface the error so users know what went wrong. Per-job calls in
    // local-job.ts will retry, so this doesn't block startup.
    console.error(`[Agent CI] Image prefetch failed: ${(err as Error).message}`);
  }
}

/**
 * Pull the upstream runner image with user-visible progress output.
 * On a cold cache (first run), pulling ~300 MB can take 30-60s — without
 * feedback the CLI appears stuck. This mirrors the progress tracking that
 * direct-container mode already does in local-job.ts.
 */
async function pullUpstreamRunnerImage(docker: Docker): Promise<void> {
  try {
    await docker.getImage(UPSTREAM_RUNNER_IMAGE).inspect();
    return; // already cached
  } catch {
    // not present — fall through to pull
  }

  process.stderr.write(
    `\nPulling runner image ${UPSTREAM_RUNNER_IMAGE}...\n` +
      `  First run downloads the image (~300 MB); subsequent runs use the cache.\n\n`,
  );

  await new Promise<void>((resolve, reject) => {
    docker.pull(UPSTREAM_RUNNER_IMAGE, (err: Error | null, stream: NodeJS.ReadableStream) => {
      if (err) {
        return reject(
          new Error(`Failed to pull runner image '${UPSTREAM_RUNNER_IMAGE}': ${err.message}`),
        );
      }

      const layerProgress = new Map<string, { current: number; total: number }>();
      let currentPhase: "downloading" | "extracting" = "downloading";
      let lastUpdate = 0;

      const flushProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdate < 500) {
          return;
        }
        lastUpdate = now;
        let totalBytes = 0;
        let currentBytes = 0;
        for (const l of layerProgress.values()) {
          totalBytes += l.total;
          currentBytes += l.current;
        }
        if (totalBytes > 0) {
          const pct = Math.round((currentBytes / totalBytes) * 100);
          const currentMB = (currentBytes / 1_048_576).toFixed(0);
          const totalMB = (totalBytes / 1_048_576).toFixed(0);
          const label = currentPhase === "downloading" ? "Downloading" : "Extracting";
          process.stderr.write(`\r  ${label}: ${pct}% (${currentMB} MB / ${totalMB} MB)  `);
        }
      };

      docker.modem.followProgress(
        stream,
        (err: Error | null) => {
          process.stderr.write("\r" + " ".repeat(60) + "\r");
          if (err) {
            reject(
              new Error(`Failed to pull runner image '${UPSTREAM_RUNNER_IMAGE}': ${err.message}`),
            );
          } else {
            process.stderr.write(`  Done.\n\n`);
            resolve();
          }
        },
        (event: {
          status?: string;
          id?: string;
          progressDetail?: { current?: number; total?: number };
        }) => {
          if (!event.id) {
            return;
          }
          const detail = event.progressDetail;
          const hasByteCounts =
            detail &&
            typeof detail.current === "number" &&
            typeof detail.total === "number" &&
            detail.total > 0;

          if (event.status === "Downloading" && hasByteCounts) {
            layerProgress.set(event.id, { current: detail.current!, total: detail.total! });
          } else if (event.status === "Download complete") {
            const existing = layerProgress.get(event.id);
            if (existing) {
              existing.current = existing.total;
            }
          } else if (event.status === "Extracting" && hasByteCounts) {
            if (currentPhase !== "extracting") {
              currentPhase = "extracting";
              layerProgress.clear();
              flushProgress(true);
            }
            layerProgress.set(event.id, { current: detail.current!, total: detail.total! });
          } else if (event.status === "Pull complete") {
            const existing = layerProgress.get(event.id);
            if (existing) {
              existing.current = existing.total;
            }
          } else {
            return;
          }
          flushProgress();
        },
      );
    });
  });
}

/**
 * Scan every workflow for `${{ vars.FOO }}` references and exit with a
 * combined error listing the missing vars and the `--var` flags needed.
 * Called at the start of a run so users find out before any setup work
 * happens.
 */
function preflightVars(workflowPaths: string[], vars: Record<string, string>): void {
  const perFile: { file: string; missing: string[] }[] = [];
  const allMissing = new Set<string>();
  for (const wf of workflowPaths) {
    let refs: string[];
    try {
      refs = extractVarRefs(wf);
    } catch {
      continue;
    }
    const missing = refs.filter((n) => !vars[n]);
    if (missing.length > 0) {
      perFile.push({ file: wf, missing });
      for (const n of missing) {
        allMissing.add(n);
      }
    }
  }
  if (allMissing.size === 0) {
    return;
  }
  const lines: string[] = [
    `[Agent CI] Missing vars required by workflow(s):`,
    "",
    ...perFile.map((m) => {
      const rel = path.relative(process.cwd(), m.file);
      const display = rel.startsWith("..") ? m.file : rel;
      return `  ${display}: ${m.missing.join(", ")}`;
    }),
    "",
    `Pass them via --var NAME=value (one flag per variable):`,
    "",
    ...Array.from(allMissing)
      .sort()
      .map((n) => `  --var ${n}=<value>`),
    "",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}

// ─── runWorkflows ──────────────────────────────────────────────────────────────
// Single entry point for both `--workflow` and `--all`.
// One workflow = --all with a single entry.

async function runWorkflows(options: {
  workflowPaths: string[];
  sha?: string;
  pauseOnFailure: boolean;
  noMatrix?: boolean;
  githubToken?: string;
  maxJobs?: number;
  vars?: Record<string, string>;
}): Promise<JobResult[]> {
  const { workflowPaths, sha, pauseOnFailure, noMatrix = false, githubToken, vars } = options;

  // Pre-flight: scan all workflows for required vars before doing any setup
  // work. Catches missing vars up front instead of mid-run.
  preflightVars(workflowPaths, vars ?? {});

  // Suppress EventEmitter MaxListenersExceeded warnings when running many
  // parallel jobs (each job adds SIGINT/SIGTERM listeners).
  process.setMaxListeners(0);

  // Create the run state store — single source of truth for all progress
  const runId = `run-${Date.now()}`;
  const storeFilePath = path.join(getWorkingDirectory(), "runs", runId, "run-state.json");
  const store = new RunStateStore(runId, storeFilePath);

  // Start the render loop — reads from store, never touches execution logic
  // In agent mode (AI_AGENT=1 or --quiet), skip animated rendering to avoid token waste
  // but register a synchronous callback for important state changes.
  let renderInterval: ReturnType<typeof setInterval> | null = null;
  let renderer: ReturnType<typeof createDiffRenderer> | null = null;
  if (isAgentMode()) {
    const reportedPauses = new Set<string>();
    const reportedSteps = new Map<string, Set<string>>();
    const emit = (msg: string) => process.stderr.write(msg + "\n");
    store.onUpdate((state) => {
      for (const wf of state.workflows) {
        for (const job of wf.jobs) {
          if (!reportedSteps.has(job.runnerId)) {
            reportedSteps.set(job.runnerId, new Set());
          }
          const seen = reportedSteps.get(job.runnerId)!;
          for (const step of job.steps) {
            const key = `${step.index}:${step.status}`;
            if (seen.has(key)) {
              continue;
            }
            if (step.status === "completed" || step.status === "running") {
              seen.add(key);
            } else if (step.status === "failed") {
              seen.add(key);
              emit(`  ✗ ${step.name}`);
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
    renderer = createDiffRenderer();
    const render = renderer;
    renderInterval = setInterval(() => {
      const state = store.getState();
      if (state.workflows.length > 0) {
        render.update(renderRunState(state));
      }
    }, 80);
  }

  // Top-level signal handler: exit the process after per-job handlers have
  // cleaned up their containers. All listeners fire synchronously in
  // registration order, so we defer the exit to let per-job handlers
  // (registered later in local-job.ts) run first.
  const exitOnSignal = () => {
    setTimeout(() => process.exit(1), 0);
  };
  process.on("SIGINT", exitOnSignal);
  process.on("SIGTERM", exitOnSignal);
  process.on("SIGHUP", exitOnSignal);

  // Pre-register all workflows so they appear immediately in the render
  // loop (as "queued") before any bootstrap or execution starts.
  for (const wp of workflowPaths) {
    store.addWorkflow(wp);
  }

  // ── Session bootstrap ─────────────────────────────────────────────────────
  // Global Docker/workspace cleanup + image prefetch run once per session
  // instead of per-workflow. With `--all` launching many workflows in
  // parallel, running these inside handleWorkflow() hammered the Docker
  // daemon (N× `docker volume prune`, N× cold-start image pulls) and
  // serialized work that should have been free. See issue #211.
  // Skip Docker cleanup when running nested inside a container (e.g.
  // smoke-bun-setup step 8). The shared Docker socket exposes the host's
  // containers, and killOrphanedContainers would kill our parent container
  // because host PIDs don't exist in the container's PID namespace.
  if (!fs.existsSync("/.dockerenv")) {
    pruneOrphanedDockerResources();
    killOrphanedContainers();
  }
  pruneStaleWorkspaces(getWorkingDirectory(), 24 * 60 * 60 * 1000);
  await prefetchRunnerImages(workflowPaths);

  // Global concurrency limiter shared across all workflows. Without this,
  // --all mode launches every workflow in parallel — leading to 20+
  // simultaneous containers that exhaust available memory and trigger
  // OOM kills (exit 137). See issue #225.
  const globalLimiter = createConcurrencyLimiter(options.maxJobs ?? getDefaultMaxConcurrentJobs());

  try {
    const allResults: JobResult[] = [];

    if (workflowPaths.length === 1) {
      // Single workflow — no cross-workflow warm-cache serialization needed
      const results = await handleWorkflow({
        workflowPath: workflowPaths[0],
        sha,
        pauseOnFailure,
        noMatrix,
        store,
        githubToken,
        globalLimiter,
        vars,
      });
      allResults.push(...results);
    } else {
      // Multiple workflows (--all mode)
      // Determine warm-cache status from the first workflow's repo root
      const firstRepoRoot = resolveRepoRootFromWorkflow(workflowPaths[0]);
      config.GITHUB_REPO ??= resolveRepoSlug(firstRepoRoot);
      const repoSlug = config.GITHUB_REPO.replace("/", "-");
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

      // Pre-allocate unique run numbers so parallel workflows don't collide.
      // Each workflow gets its own baseRunNum (e.g. 306, 307, 308) so their
      // job suffixes (-j1, -j2, -j3) never produce duplicate container names.
      const baseRunNum = getNextLogNum("agent-ci");
      const runNums = workflowPaths.map((_, i) => baseRunNum + i);

      if (!warm && workflowPaths.length > 1) {
        // Cold cache — run first workflow serially to populate warm modules,
        // then launch the rest in parallel.
        const firstResults = await handleWorkflow({
          workflowPath: workflowPaths[0],
          sha,
          pauseOnFailure,
          noMatrix,
          store,
          baseRunNum: runNums[0],
          githubToken,
          globalLimiter,
        });
        allResults.push(...firstResults);

        const settled = await Promise.allSettled(
          workflowPaths.slice(1).map((wf, i) =>
            handleWorkflow({
              workflowPath: wf,
              sha,
              pauseOnFailure,
              noMatrix,
              store,
              baseRunNum: runNums[i + 1],
              githubToken,
              globalLimiter,
              vars,
            }),
          ),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") {
            allResults.push(...s.value);
          } else {
            console.error(`\n[Agent CI] Workflow failed: ${s.reason?.message || String(s.reason)}`);
          }
        }
      } else {
        const settled = await Promise.allSettled(
          workflowPaths.map((wf, i) =>
            handleWorkflow({
              workflowPath: wf,
              sha,
              pauseOnFailure,
              noMatrix,
              store,
              baseRunNum: runNums[i],
              githubToken,
              globalLimiter,
              vars,
            }),
          ),
        );
        for (const s of settled) {
          if (s.status === "fulfilled") {
            allResults.push(...s.value);
          } else {
            console.error(`\n[Agent CI] Workflow failed: ${s.reason?.message || String(s.reason)}`);
          }
        }
      }
    }

    store.complete(allResults.some((r) => !r.succeeded) ? "failed" : "completed");
    return allResults;
  } finally {
    process.removeListener("SIGINT", exitOnSignal);
    process.removeListener("SIGTERM", exitOnSignal);
    process.removeListener("SIGHUP", exitOnSignal);
    if (renderInterval) {
      clearInterval(renderInterval);
    }
    if (renderer) {
      // Final render — show the completed state
      const finalState = store.getState();
      if (finalState.workflows.length > 0) {
        renderer.update(renderRunState(finalState));
      }
      renderer.done();
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
  noMatrix?: boolean;
  store: RunStateStore;
  baseRunNum?: number;
  githubToken?: string;
  globalLimiter: ReturnType<typeof createConcurrencyLimiter>;
  vars?: Record<string, string>;
}): Promise<JobResult[]> {
  const { sha, pauseOnFailure, noMatrix = false, store, githubToken } = options;
  const vars = options.vars ?? {};
  let workflowPath = options.workflowPath;

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
  // Always resolve a SHA that represents the code being executed.
  // When the working tree is dirty and no explicit --sha was given, compute an
  // ephemeral commit SHA that captures the dirty state (including untracked files).
  // This is purely informational — actions/checkout is always stubbed, so no
  // workflow will ever try to fetch this SHA from a remote.
  const realHeadSha =
    headSha ?? computeDirtySha(repoRoot) ?? resolveHeadSha(repoRoot, "HEAD").headSha;
  const baseSha = resolveBaseSha(repoRoot, realHeadSha);
  const githubRepo = config.GITHUB_REPO ?? resolveRepoSlug(repoRoot);
  config.GITHUB_REPO = githubRepo;
  const [owner, name] = githubRepo.split("/");

  const remoteCacheDir = path.resolve(getWorkingDirectory(), "cache", "remote-workflows");
  const remoteCache = await prefetchRemoteWorkflows(workflowPath, remoteCacheDir, githubToken);
  const expandedEntries = expandReusableJobs(workflowPath, repoRoot, remoteCache);

  if (expandedEntries.length === 0) {
    debugCli(`[Agent CI] No jobs found in workflow: ${path.basename(workflowPath)}`);
    return [];
  }

  // ── Collect expanded jobs (with matrix expansion) ─────────────────────────
  type ExpandedJob = {
    workflowPath: string;
    taskName: string;
    sourceTaskName?: string;
    matrixContext?: Record<string, string>;
    inputs?: Record<string, string>;
    inputDefaults?: Record<string, string>;
    workflowCallOutputDefs?: Record<string, string>;
    callerJobId?: string;
  };

  const expandedJobs: ExpandedJob[] = [];

  for (const entry of expandedEntries) {
    const matrixDef = await parseMatrixDef(entry.workflowPath, entry.sourceTaskName);
    if (matrixDef) {
      const combos = noMatrix
        ? collapseMatrixToSingle(matrixDef)
        : expandMatrixCombinations(matrixDef);
      const total = combos.length;
      for (let ci = 0; ci < combos.length; ci++) {
        expandedJobs.push({
          workflowPath: entry.workflowPath,
          taskName: entry.id,
          sourceTaskName: entry.sourceTaskName,
          matrixContext: noMatrix
            ? combos[ci]
            : {
                ...combos[ci],
                __job_total: String(total),
                __job_index: String(ci),
              },
          inputs: entry.inputs,
          inputDefaults: entry.inputDefaults,
          workflowCallOutputDefs: entry.workflowCallOutputDefs,
          callerJobId: entry.callerJobId,
        });
      }
    } else {
      expandedJobs.push({
        workflowPath: entry.workflowPath,
        taskName: entry.id,
        sourceTaskName: entry.sourceTaskName,
        inputs: entry.inputs,
        inputDefaults: entry.inputDefaults,
        workflowCallOutputDefs: entry.workflowCallOutputDefs,
        callerJobId: entry.callerJobId,
      });
    }
  }

  // Pre-register all jobs so they appear as "queued" in the render loop
  // before execution starts. Uses the same naming convention as buildJob.
  // Only in multi-workflow mode (baseRunNum is set) where naming is deterministic.
  if (expandedJobs.length > 1 && options.baseRunNum != null) {
    for (let i = 0; i < expandedJobs.length; i++) {
      const ej = expandedJobs[i];
      let suffix = `-j${i + 1}`;
      if (ej.matrixContext) {
        const shardIdx = parseInt(ej.matrixContext.__job_index ?? "0", 10) + 1;
        suffix += `-m${shardIdx}`;
      }
      const runnerId = `agent-ci-${options.baseRunNum}${suffix}`;
      const storeWfPath = ej.callerJobId ? workflowPath : ej.workflowPath;
      store.addJob(storeWfPath, ej.taskName, runnerId, {
        matrixValues: ej.matrixContext
          ? Object.fromEntries(
              Object.entries(ej.matrixContext).filter(([k]) => !k.startsWith("__")),
            )
          : undefined,
      });
    }
  }

  // ── Unsupported-OS skip (shared between single- and multi-job paths) ──────
  // Jobs with `runs-on: macos-*` or `windows-*` can't be executed locally
  // today — agent-ci only runs jobs in a Linux container. Rather than
  // silently landing them there and failing at the first OS-specific step,
  // we skip them with a visible warning. See:
  //   https://github.com/redwoodjs/agent-ci/issues/254  (this guardrail)
  //   https://github.com/redwoodjs/agent-ci/issues/258  (real macOS support)
  const skippedResult = (ej: ExpandedJob): JobResult => ({
    name: `agent-ci-skipped-${ej.taskName}`,
    workflow: path.basename(ej.workflowPath),
    taskId: ej.taskName,
    succeeded: true,
    durationMs: 0,
    debugLogPath: "",
    steps: [],
  });
  const warnedUnsupportedOS = new Set<string>();
  const macosVmHost = checkMacosVmHost();
  const classifyJob = (ej: ExpandedJob) => {
    const labels = parseJobRunsOn(ej.workflowPath, ej.sourceTaskName ?? ej.taskName);
    return { labels, kind: classifyRunsOn(labels) };
  };
  const canRunMacosHere = (kind: RunnerOSKind) => kind === "macos" && macosVmHost.supported;
  const maybeSkipUnsupportedOS = (ej: ExpandedJob): JobResult | null => {
    const { labels, kind } = classifyJob(ej);
    if (!isUnsupportedOS(kind) || canRunMacosHere(kind)) {
      return null;
    }
    if (!warnedUnsupportedOS.has(ej.taskName)) {
      warnedUnsupportedOS.add(ej.taskName);
      const capability = kind === "macos" && !macosVmHost.supported ? macosVmHost : undefined;
      process.stderr.write(
        formatUnsupportedOSWarning(ej.taskName, labels, kind, capability) + "\n\n",
      );
    }
    return skippedResult(ej);
  };
  // Returns the executor for a job. Callers have already filtered out
  // OS-skipped jobs via maybeSkipUnsupportedOS.
  const runJobExecutor = (ej: ExpandedJob, job: Job): Promise<JobResult> => {
    if (canRunMacosHere(classifyJob(ej).kind)) {
      return executeMacosVmJob(job);
    }
    return executeLocalJob(job, { pauseOnFailure, store });
  };

  // For single-job workflows, run directly without extra orchestration
  if (expandedJobs.length === 1) {
    const ej = expandedJobs[0];
    const osSkip = maybeSkipUnsupportedOS(ej);
    if (osSkip) {
      return [osSkip];
    }
    const actualTaskName = ej.sourceTaskName ?? ej.taskName;
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);

    // Resolve inputs for called workflow jobs
    let inputsContext: Record<string, string> | undefined;
    if (ej.callerJobId) {
      inputsContext = { ...ej.inputDefaults };
      if (ej.inputs) {
        for (const [k, v] of Object.entries(ej.inputs)) {
          inputsContext[k] = expandExpressions(
            v,
            repoRoot,
            secrets,
            undefined,
            undefined,
            undefined,
            vars,
          );
        }
      }
      if (Object.keys(inputsContext).length === 0) {
        inputsContext = undefined;
      }
    }

    const steps = await parseWorkflowSteps(
      ej.workflowPath,
      actualTaskName,
      secrets,
      ej.matrixContext,
      undefined,
      inputsContext,
      vars,
    );
    const services = await parseWorkflowServices(ej.workflowPath, actualTaskName);
    const container = await parseWorkflowContainer(ej.workflowPath, actualTaskName);

    const job: Job = {
      deliveryId: `run-${Date.now()}`,
      eventType: "workflow_job",
      githubJobId: `local-${Date.now()}-${Math.floor(Math.random() * 100000)}`,
      githubRepo: githubRepo,
      githubToken: "mock_token",
      headSha: headSha,
      baseSha: baseSha,
      realHeadSha: realHeadSha,
      repoRoot: repoRoot,
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
      workflowPath: ej.workflowPath,
      parentWorkflowPath: ej.callerJobId ? workflowPath : undefined,
      taskId: ej.taskName,
    };

    const result = await options.globalLimiter.run(() => runJobExecutor(ej, job));
    return [result];
  }

  // ── Multi-job orchestration ────────────────────────────────────────────────
  const limiter = options.globalLimiter;

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
  const baseRunNum = options.baseRunNum ?? getNextLogNum("agent-ci");

  const buildJob = (ej: ExpandedJob): Job => {
    const actualTaskName = ej.sourceTaskName ?? ej.taskName;
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);

    // Use the job's position in expandedJobs (not a mutable counter) so the
    // runnerId is deterministic and matches the pre-registration at line 716.
    const idx = expandedJobs.indexOf(ej);
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
      baseSha: baseSha,
      realHeadSha: realHeadSha,
      repoRoot: repoRoot,
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
      workflowPath: ej.workflowPath,
      parentWorkflowPath: ej.callerJobId ? workflowPath : undefined,
      taskId: ej.taskName,
    };
  };

  // Cache resolved inputs per callerJobId (all sub-jobs share the same inputs)
  const resolvedInputsCache = new Map<string, Record<string, string>>();

  const resolveInputsForJob = (
    ej: ExpandedJob,
    secrets: Record<string, string>,
    needsContext?: Record<string, Record<string, string>>,
    vars?: Record<string, string>,
  ): Record<string, string> | undefined => {
    if (!ej.callerJobId) {
      return undefined;
    }
    const cached = resolvedInputsCache.get(ej.callerJobId);
    if (cached) {
      return cached;
    }

    // Start with defaults, then override with caller's `with:` values (expanded)
    const resolved: Record<string, string> = { ...ej.inputDefaults };
    if (ej.inputs) {
      for (const [k, v] of Object.entries(ej.inputs)) {
        resolved[k] = expandExpressions(
          v,
          repoRoot,
          secrets,
          undefined,
          needsContext,
          undefined,
          vars,
        );
      }
    }
    resolvedInputsCache.set(ej.callerJobId, resolved);
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  };

  const runJob = async (
    ej: ExpandedJob,
    needsContext?: Record<string, Record<string, string>>,
  ): Promise<JobResult> => {
    const { taskName, matrixContext } = ej;
    const actualTaskName = ej.sourceTaskName ?? taskName;
    debugCli(
      `Running: ${path.basename(ej.workflowPath)} | Task: ${taskName}${matrixContext ? ` | Matrix: ${JSON.stringify(Object.fromEntries(Object.entries(matrixContext).filter(([k]) => !k.startsWith("__"))))}` : ""}`,
    );
    const requiredRefs = extractSecretRefs(ej.workflowPath, actualTaskName);
    const secrets = loadMachineSecrets(repoRoot, requiredRefs);
    if (githubToken && !secrets["GITHUB_TOKEN"]) {
      secrets["GITHUB_TOKEN"] = githubToken;
    }
    const secretsFilePath = path.join(repoRoot, ".env.agent-ci");
    validateSecrets(ej.workflowPath, actualTaskName, secrets, secretsFilePath);
    validateVars(ej.workflowPath, actualTaskName, vars);
    const inputsContext = resolveInputsForJob(ej, secrets, needsContext, vars);
    const steps = await parseWorkflowSteps(
      ej.workflowPath,
      actualTaskName,
      secrets,
      matrixContext,
      needsContext,
      inputsContext,
      vars,
    );
    const services = await parseWorkflowServices(ej.workflowPath, actualTaskName);
    const container = await parseWorkflowContainer(ej.workflowPath, actualTaskName);

    const job = buildJob(ej);
    job.steps = steps;
    job.services = services;
    job.container = container ?? undefined;

    const result = await runJobExecutor(ej, job);

    // result.outputs now contains raw step outputs (extracted inside executeLocalJob
    // before workspace cleanup). Resolve them to job-level outputs using the
    // output definitions from the workflow YAML.
    if (result.outputs && Object.keys(result.outputs).length > 0) {
      const outputDefs = parseJobOutputDefs(ej.workflowPath, actualTaskName);
      if (Object.keys(outputDefs).length > 0) {
        result.outputs = resolveJobOutputs(outputDefs, result.outputs);
      }
    }

    return result;
  };

  const allResults: JobResult[] = [];
  // Accumulate job outputs across waves for needs.*.outputs.* resolution
  const jobOutputs = new Map<string, Record<string, string>>();

  // ── Dependency-aware wave scheduling ──────────────────────────────────────
  const deps = new Map<string, string[]>();
  for (const entry of expandedEntries) {
    deps.set(entry.id, entry.needs);
  }
  const waves = topoSort(deps);

  const taskNamesInWf = new Set(expandedJobs.map((j) => j.taskName));
  const filteredWaves = waves
    .map((wave) => wave.filter((jobId) => taskNamesInWf.has(jobId)))
    .filter((wave) => wave.length > 0);

  if (filteredWaves.length === 0) {
    filteredWaves.push(Array.from(taskNamesInWf));
  }

  /** Build a needsContext for a job from its dependencies' accumulated outputs */
  const buildNeedsContext = (jobId: string): Record<string, Record<string, string>> | undefined => {
    const jobDeps = deps.get(jobId);
    if (!jobDeps || jobDeps.length === 0) {
      return undefined;
    }
    const ctx: Record<string, Record<string, string>> = {};
    for (const depId of jobDeps) {
      ctx[depId] = jobOutputs.get(depId) ?? {};
      if (depId.includes("/")) {
        const callerJobId = depId.split("/")[0];
        const calledJobId = depId.split("/").slice(1).join("/");
        // For composite IDs like "lint/setup", also add the called job ID ("setup")
        // so intra-workflow `needs.setup.outputs.*` references resolve correctly
        if (!ctx[calledJobId]) {
          ctx[calledJobId] = jobOutputs.get(depId) ?? {};
        }
        // If workflow_call outputs were resolved for the caller (e.g. "lint"),
        // add them so downstream `needs.lint.outputs.*` references work
        if (jobOutputs.has(callerJobId)) {
          ctx[callerJobId] = jobOutputs.get(callerJobId)!;
        }
      }
    }
    return Object.keys(ctx).length > 0 ? ctx : undefined;
  };

  /** Collect outputs from a completed job result */
  const collectOutputs = (result: JobResult, taskName: string) => {
    if (result.outputs && Object.keys(result.outputs).length > 0) {
      jobOutputs.set(taskName, result.outputs);
    }
  };

  /**
   * After a wave completes, resolve workflow_call outputs for any caller jobs
   * whose sub-jobs have all finished. This allows downstream jobs to access
   * `needs.<callerJobId>.outputs.*`.
   */
  const resolveWorkflowCallOutputs = () => {
    // Group expanded jobs by callerJobId
    const byCallerJobId = new Map<string, ExpandedJob[]>();
    for (const ej of expandedJobs) {
      if (ej.callerJobId) {
        const group = byCallerJobId.get(ej.callerJobId) ?? [];
        group.push(ej);
        byCallerJobId.set(ej.callerJobId, group);
      }
    }

    for (const [callerJobId, subJobs] of byCallerJobId) {
      // Check if all sub-jobs have completed (have results)
      const allDone = subJobs.every((sj) => jobResultStatus.has(sj.taskName));
      if (!allDone) {
        continue;
      }
      // Already resolved
      if (jobOutputs.has(callerJobId)) {
        continue;
      }

      // Find the output defs (all sub-jobs share the same defs)
      const outputDefs = subJobs[0]?.workflowCallOutputDefs;
      if (!outputDefs || Object.keys(outputDefs).length === 0) {
        continue;
      }

      // Resolve each output value expression: ${{ jobs.<id>.outputs.<name> }}
      const resolved: Record<string, string> = {};
      for (const [outputName, valueExpr] of Object.entries(outputDefs)) {
        resolved[outputName] = valueExpr.replace(
          /\$\{\{\s*jobs\.([^.]+)\.outputs\.([^}\s]+)\s*\}\}/g,
          (_match, jobId, outputKey) => {
            const compositeId = `${callerJobId}/${jobId}`;
            return jobOutputs.get(compositeId)?.[outputKey] ?? "";
          },
        );
      }
      jobOutputs.set(callerJobId, resolved);
    }
  };

  // Track job results for if-condition evaluation (success/failure status)
  const jobResultStatus = new Map<string, string>();

  /** Check if a job should be skipped based on its if: condition */
  const shouldSkipJob = (jobId: string, ej?: ExpandedJob): boolean => {
    const ejWorkflowPath = ej?.workflowPath ?? workflowPath;
    const actualTaskName = ej?.sourceTaskName ?? jobId;
    const ifExpr = parseJobIf(ejWorkflowPath, actualTaskName);
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

  /** Run a job or skip it based on if: condition or unsupported OS */
  const runOrSkipJob = async (ej: ExpandedJob): Promise<JobResult> => {
    const osSkip = maybeSkipUnsupportedOS(ej);
    if (osSkip) {
      jobResultStatus.set(ej.taskName, "skipped");
      return osSkip;
    }
    if (shouldSkipJob(ej.taskName, ej)) {
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

  const seenErrorMessages = new Set<string>();

  for (let wi = 0; wi < filteredWaves.length; wi++) {
    const waveJobIds = new Set(filteredWaves[wi]);
    const waveJobs = expandedJobs.filter((j) => waveJobIds.has(j.taskName));

    if (waveJobs.length === 0) {
      continue;
    }

    // ── Warm-cache serialization for the first wave ────────────────────────
    if (!warm && wi === 0 && waveJobs.length > 1) {
      debugCli("Cold cache — running first job to populate warm modules...");
      const firstResult = await limiter.run(() => runOrSkipJob(waveJobs[0]));
      allResults.push(firstResult);

      const results = await Promise.allSettled(
        waveJobs.slice(1).map((ej) =>
          limiter.run(() =>
            runOrSkipJob(ej).catch((error) => {
              throw wrapJobError(ej.taskName, error);
            }),
          ),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          allResults.push(r.value);
        } else {
          const taskName = isJobError(r.reason) ? r.reason.taskName : "unknown";
          const errorMessage = isJobError(r.reason) ? r.reason.message : String(r.reason);
          if (!seenErrorMessages.has(errorMessage)) {
            seenErrorMessages.add(errorMessage);
            console.error(`\n[Agent CI] Job failed with error: ${taskName}`);
            console.error(`  Error: ${errorMessage}`);
          }
          allResults.push(createFailedJobResult(taskName, workflowPath, r.reason));
        }
      }
      warm = true;
    } else {
      const results = await Promise.allSettled(
        waveJobs.map((ej) =>
          limiter.run(() =>
            runOrSkipJob(ej).catch((error) => {
              throw wrapJobError(ej.taskName, error);
            }),
          ),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          allResults.push(r.value);
        } else {
          const taskName = isJobError(r.reason) ? r.reason.taskName : "unknown";
          const errorMessage = isJobError(r.reason) ? r.reason.message : String(r.reason);
          if (!seenErrorMessages.has(errorMessage)) {
            seenErrorMessages.add(errorMessage);
            console.error(`\n[Agent CI] Job failed with error: ${taskName}`);
            console.error(`  Error: ${errorMessage}`);
          }
          allResults.push(createFailedJobResult(taskName, workflowPath, r.reason));
        }
      }
    }

    // After each wave, resolve workflow_call outputs for completed caller jobs
    resolveWorkflowCallOutputs();

    // Check whether to abort remaining waves on failure
    const waveHadFailures = allResults.some((r) => !r.succeeded);
    if (waveHadFailures && wi < filteredWaves.length - 1) {
      // Check fail-fast setting for jobs in this wave
      const waveFailFastSettings = waveJobs.map((ej) =>
        parseFailFast(ej.workflowPath, ej.sourceTaskName ?? ej.taskName),
      );
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
  console.log(
    "  -j, --jobs <n>                Max concurrent containers (auto-detected from CPU/memory)",
  );
  console.log("  -p, --pause-on-failure         Pause on step failure for interactive debugging");
  console.log(
    "  -q, --quiet                   Suppress animated rendering (also enabled by AI_AGENT=1)",
  );
  console.log(
    "      --no-matrix               Collapse all matrix combinations into a single job (uses first value of each key)",
  );
  console.log(
    "      --github-token [<token>]  GitHub token for fetching remote reusable workflows",
  );
  console.log(
    "                                (auto-resolves via `gh auth token` if no value given)",
  );
  console.log("                                Or set: AGENT_CI_GITHUB_TOKEN env var");
  console.log(
    "      --commit-status           Post a GitHub commit status after the run (requires --github-token)",
  );
  console.log(
    "      --var KEY=VALUE           Provide a workflow variable (${{ vars.KEY }}); repeat for multiple",
  );
  console.log("");
  console.log("Secrets:");
  console.log("  Workflow secrets (${{ secrets.FOO }}) are resolved from:");
  console.log("    1. .env.agent-ci file in the repo root");
  console.log("    2. Environment variables (shell env acts as fallback)");
  console.log("    3. --github-token automatically provides secrets.GITHUB_TOKEN");
  console.log("");
  console.log("Vars:");
  console.log("  Workflow vars (${{ vars.FOO }}) must be provided via --var FOO=VALUE.");
  console.log("  The run fails if any referenced var is missing.");
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

function persistRunResult(opts: {
  results: JobResult[];
  repoRoot: string;
  startedAt: Date;
  sha?: string;
  branch?: string;
}): void {
  try {
    const repo = config.GITHUB_REPO ?? resolveRepoSlug(opts.repoRoot);
    const branch =
      opts.branch ??
      execSync("git rev-parse --abbrev-ref HEAD", { cwd: opts.repoRoot }).toString().trim();
    const headSha = (
      opts.sha ?? execSync("git rev-parse HEAD", { cwd: opts.repoRoot }).toString()
    ).trim();
    writeRunResult({
      repo,
      branch,
      worktreePath: opts.repoRoot,
      headSha,
      startedAt: opts.startedAt,
      finishedAt: new Date(),
      results: opts.results,
    });
  } catch {
    // Best-effort: never let result persistence fail the run.
  }
}

/** Resolve the parent commit SHA for push-event `before` context. */
function resolveBaseSha(repoRoot: string, headSha?: string): string | undefined {
  try {
    const ref = headSha && headSha !== "HEAD" ? `${headSha}~1` : "HEAD~1";
    return execSync(`git rev-parse ${ref}`, { cwd: repoRoot, stdio: "pipe" }).toString().trim();
  } catch {
    return undefined;
  }
}

run().catch((err) => {
  console.error("[Agent CI] Fatal error:", err);
  process.exit(1);
});
