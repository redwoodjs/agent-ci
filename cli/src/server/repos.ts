import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "../working-directory.js";
import { broadcastEvent } from "./events.js";
import { runWorkflow } from "./runner.js";

const execAsync = promisify(execFile);

// ─── Config Paths ─────────────────────────────────────────────────────────────

const OA_DIR = path.join(PROJECT_ROOT, "_");
const getRecentReposPath = () => path.join(OA_DIR, "recent_repos.json");
const getWatchedReposPath = () => path.join(OA_DIR, "watched_repos.json");
const getWorkflowOverridesPath = () => path.join(OA_DIR, "workflows.json");

async function ensureDataDir() {
  await fs.mkdir(OA_DIR, { recursive: true });
}

// ─── Recent Repos ─────────────────────────────────────────────────────────────

export async function getRecentRepos(): Promise<string[]> {
  try {
    const data = await fs.readFile(getRecentReposPath(), "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function addRecentRepo(repoPath: string) {
  await ensureDataDir();
  let repos = await getRecentRepos();
  repos = [repoPath, ...repos.filter((p: string) => p !== repoPath)].slice(0, 10);
  await fs.writeFile(getRecentReposPath(), JSON.stringify(repos, null, 2));
}

export async function removeRecentRepo(repoPath: string) {
  let repos = await getRecentRepos();
  repos = repos.filter((p: string) => p !== repoPath);
  await fs.writeFile(getRecentReposPath(), JSON.stringify(repos, null, 2));
}

// ─── Watched Repos (State + FS Watcher) ──────────────────────────────────────

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
  await ensureDataDir();
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

// ─── Workflow enabled/disabled overrides ──────────────────────────────────────
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
  await ensureDataDir();
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

// ─── Workflows ────────────────────────────────────────────────────────────────

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
