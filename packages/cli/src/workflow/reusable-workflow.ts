import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export interface ExpandedJobEntry {
  /** Composite ID: "callerJobId/calledJobId" for inlined jobs, or original ID */
  id: string;
  /** The workflow file containing this job's steps */
  workflowPath: string;
  /** The job ID within workflowPath (for YAML lookup) */
  sourceTaskName: string;
  /** Dependencies (rewired to use composite IDs for inlined jobs) */
  needs: string[];
}

/**
 * Expand reusable workflow jobs (`uses: ./.github/workflows/...`) into concrete
 * job entries that can be scheduled alongside regular jobs.
 *
 * Only local refs (starting with `./`) are supported. Remote refs are warned
 * and skipped. Nested reusable workflows throw an error.
 */
export function expandReusableJobs(workflowPath: string, repoRoot: string): ExpandedJobEntry[] {
  const raw = parseYaml(fs.readFileSync(workflowPath, "utf-8"));
  const jobs = raw?.jobs ?? {};

  const entries: ExpandedJobEntry[] = [];

  // Track which caller job IDs map to which inlined terminal job IDs,
  // so we can rewire downstream `needs:` references.
  const callerToTerminals = new Map<string, string[]>();

  for (const [jobId, jobDef] of Object.entries<any>(jobs)) {
    const uses = jobDef?.uses;
    if (typeof uses === "string") {
      // This is a reusable workflow call
      if (!uses.startsWith("./")) {
        console.warn(`[Agent CI] Skipping remote reusable workflow: ${jobId} uses ${uses}`);
        continue;
      }

      const calledPath = path.resolve(repoRoot, uses);
      if (!fs.existsSync(calledPath)) {
        console.warn(
          `[Agent CI] Reusable workflow file not found: ${calledPath} (referenced by job "${jobId}")`,
        );
        continue;
      }

      const calledRaw = parseYaml(fs.readFileSync(calledPath, "utf-8"));
      const calledJobs = calledRaw?.jobs ?? {};

      // Guard against nested reusable workflows
      for (const [cjId, cjDef] of Object.entries<any>(calledJobs)) {
        if (typeof cjDef?.uses === "string") {
          throw new Error(
            `Nested reusable workflows are not supported: job "${cjId}" in ${calledPath} calls "${cjDef.uses}"`,
          );
        }
      }

      const callerNeeds = parseNeeds(jobDef?.needs);

      // Find terminal jobs in the called workflow (jobs that no other job depends on)
      const calledJobIds = new Set(Object.keys(calledJobs));
      const depended = new Set<string>();
      for (const [, cjDef] of Object.entries<any>(calledJobs)) {
        for (const n of parseNeeds(cjDef?.needs)) {
          depended.add(n);
        }
      }
      const terminalIds = [...calledJobIds].filter((id) => !depended.has(id));

      const terminals: string[] = [];

      for (const [cjId, cjDef] of Object.entries<any>(calledJobs)) {
        const compositeId = `${jobId}/${cjId}`;
        const internalNeeds = parseNeeds(cjDef?.needs);

        let needs: string[];
        if (internalNeeds.length === 0) {
          // Entry-point job in called workflow: inherits caller's needs
          needs = callerNeeds;
        } else {
          // Internal deps get prefixed with caller job ID
          needs = internalNeeds.map((n) => `${jobId}/${n}`);
        }

        entries.push({
          id: compositeId,
          workflowPath: calledPath,
          sourceTaskName: cjId,
          needs,
        });

        if (terminalIds.includes(cjId)) {
          terminals.push(compositeId);
        }
      }

      callerToTerminals.set(jobId, terminals);
    } else {
      // Regular job — has `steps:` or `runs-on:`
      entries.push({
        id: jobId,
        workflowPath,
        sourceTaskName: jobId,
        needs: parseNeeds(jobDef?.needs),
      });
    }
  }

  // Rewire downstream dependencies: any job that `needs: [callerJobId]`
  // should now depend on the terminal jobs of the inlined sub-graph
  for (const entry of entries) {
    entry.needs = entry.needs.flatMap((dep) => {
      const terminals = callerToTerminals.get(dep);
      if (terminals && terminals.length > 0) {
        return terminals;
      }
      return [dep];
    });
  }

  return entries;
}

function parseNeeds(needs: unknown): string[] {
  if (!needs) {
    return [];
  }
  if (typeof needs === "string") {
    return [needs];
  }
  if (Array.isArray(needs)) {
    return needs.map(String);
  }
  return [];
}
