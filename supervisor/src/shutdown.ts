import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ─── Docker container cleanup ─────────────────────────────────────────────────

/**
 * Force-kill ALL `machinen-*` Docker containers (runners + service sidecars)
 * and remove their associated `machinen-net-*` bridge networks.
 *
 * This is the "nuclear" cleanup — used when the supervisor process is shutting
 * down and we want to guarantee no orphaned containers remain.
 */
export function killAllRunnerContainers(): void {
  // 1. Force-remove all containers whose name starts with `machinen-`
  //    This catches both runner containers (machinen-14) and service sidecars
  //    (machinen-14-svc-mysql, machinen-14-svc-redis, etc.)
  try {
    const ids = execSync(`docker ps -aq --filter "name=machinen-"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (ids) {
      execSync(`docker rm -f ${ids.split("\n").join(" ")}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch {
    // Docker may not be reachable or no matching containers — fine
  }

  // 2. Remove all bridge networks whose name starts with `machinen-net-`
  try {
    const nets = execSync(`docker network ls -q --filter "name=machinen-net-"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (nets) {
      for (const netId of nets.split("\n")) {
        try {
          execSync(`docker network rm ${netId}`, {
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Network may still have connected containers — skip
        }
      }
    }
  } catch {
    // Docker may not be reachable — fine
  }
}

/**
 * Force-kill a specific runner and its associated service containers + network.
 * Used when stopping a single workflow run.
 */
export function killRunnerContainers(runnerName: string): void {
  // 1. Force-remove the runner container itself
  try {
    execSync(`docker rm -f ${runnerName}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // already gone
  }

  // 2. Force-remove any svc-* sidecars for this runner
  try {
    const ids = execSync(`docker ps -aq --filter "name=${runnerName}-svc-"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (ids) {
      execSync(`docker rm -f ${ids.split("\n").join(" ")}`, {
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
  } catch {
    // no sidecars or Docker not reachable
  }

  // 3. Remove the shared bridge network
  try {
    execSync(`docker network rm machinen-net-${runnerName}`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // network doesn't exist or already removed
  }
}

/**
 * Remove orphaned Docker resources left behind by previous runs:
 *   1. `machinen-net-*` networks with no connected containers
 *   2. Dangling volumes (anonymous volumes from service containers like MySQL)
 *
 * Call this proactively before creating new resources to prevent Docker from
 * exhausting its address pool ("all predefined address pools have been fully subnetted").
 */
export function pruneOrphanedDockerResources(): void {
  // 1. Remove orphaned machinen-net-* networks
  try {
    const nets = execSync(`docker network ls -q --filter "name=machinen-net-"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (nets) {
      for (const netId of nets.split("\n")) {
        try {
          // docker network rm fails if containers are still attached — that's fine,
          // we only want to remove truly orphaned networks.
          execSync(`docker network rm ${netId}`, {
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch {
          // Network still in use — skip
        }
      }
    }
  } catch {
    // Docker not reachable — skip
  }

  // 2. Remove dangling volumes (anonymous volumes from service containers)
  try {
    execSync(`docker volume prune -f`, {
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    // Docker not reachable — skip
  }
}

// ─── Workspace pruning ────────────────────────────────────────────────────────

/**
 * Remove stale `machinen-*` run directories older than `maxAgeMs` from
 * `<workDir>/runs/`. Each run dir contains logs, work, shims, and diag
 * co-located, so a single rm removes everything for that run.
 *
 * Returns an array of directory names that were pruned.
 */
export function pruneStaleWorkspaces(workDir: string, maxAgeMs: number): string[] {
  const runsPath = path.join(workDir, "runs");
  if (!fs.existsSync(runsPath)) {
    return [];
  }

  const now = Date.now();
  const pruned: string[] = [];

  for (const entry of fs.readdirSync(runsPath, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("machinen-")) {
      continue;
    }

    const dirPath = path.join(runsPath, entry.name);
    try {
      const stat = fs.statSync(dirPath);
      const ageMs = now - stat.mtimeMs;
      if (ageMs > maxAgeMs) {
        fs.rmSync(dirPath, { recursive: true, force: true });
        pruned.push(entry.name);
      }
    } catch {
      // Skip dirs we can't stat
    }
  }

  return pruned;
}
