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
  /** Raw caller `with:` values (unexpanded expressions) */
  inputs?: Record<string, string>;
  /** Defaults from `on.workflow_call.inputs.<name>.default` */
  inputDefaults?: Record<string, string>;
  /** Output value expressions from `on.workflow_call.outputs.<name>.value` */
  workflowCallOutputDefs?: Record<string, string>;
  /** Original caller job ID (set on inlined sub-jobs) */
  callerJobId?: string;
}

const MAX_REUSABLE_DEPTH = 4;

/**
 * Expand reusable workflow jobs (`uses: ./.github/workflows/...`) into concrete
 * job entries that can be scheduled alongside regular jobs.
 *
 * Local refs (starting with `./`) are resolved relative to repoRoot.
 * Remote refs are resolved via the remoteCache map (pre-fetched by
 * prefetchRemoteWorkflows). Nesting is supported up to 4 levels deep
 * (matching GitHub Actions' limit). Cycles are detected and rejected.
 */
export function expandReusableJobs(
  workflowPath: string,
  repoRoot: string,
  remoteCache?: Map<string, string>,
): ExpandedJobEntry[] {
  return expandReusableJobsInternal(workflowPath, repoRoot, remoteCache, 0, new Set());
}

function expandReusableJobsInternal(
  workflowPath: string,
  repoRoot: string,
  remoteCache: Map<string, string> | undefined,
  depth: number,
  visitedPaths: Set<string>,
): ExpandedJobEntry[] {
  if (depth > MAX_REUSABLE_DEPTH) {
    throw new Error(
      `Reusable workflow nesting depth exceeds maximum of ${MAX_REUSABLE_DEPTH}: ${workflowPath}`,
    );
  }

  const resolvedPath = path.resolve(workflowPath);
  if (visitedPaths.has(resolvedPath)) {
    throw new Error(
      `Cycle detected in reusable workflows: ${resolvedPath} is already in the call chain`,
    );
  }
  visitedPaths.add(resolvedPath);

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
      let calledPath: string;
      if (uses.startsWith("./")) {
        calledPath = path.resolve(repoRoot, uses);
      } else {
        const cached = remoteCache?.get(uses);
        if (!cached) {
          throw new Error(`Remote reusable workflow not resolved: job "${jobId}" uses ${uses}`);
        }
        calledPath = cached;
      }

      if (!fs.existsSync(calledPath)) {
        throw new Error(
          `Reusable workflow file not found: ${calledPath} (referenced by job "${jobId}")`,
        );
      }

      // Extract caller inputs (raw `with:` values)
      const callerWith: Record<string, string> | undefined = jobDef.with
        ? Object.fromEntries(Object.entries(jobDef.with).map(([k, v]) => [k, String(v)]))
        : undefined;

      // Extract input defaults and output defs from the called workflow's on.workflow_call
      const calledRaw = parseYaml(fs.readFileSync(calledPath, "utf-8"));
      const wcInputs = (calledRaw.on || calledRaw.true)?.workflow_call?.inputs;
      const inputDefaults: Record<string, string> | undefined =
        wcInputs && typeof wcInputs === "object"
          ? Object.fromEntries(
              Object.entries(wcInputs)
                .filter(([, def]: [string, any]) => def?.default != null)
                .map(([k, def]: [string, any]) => [k, String(def.default)]),
            )
          : undefined;

      const wcOutputs = (calledRaw.on || calledRaw.true)?.workflow_call?.outputs;
      const workflowCallOutputDefs: Record<string, string> | undefined =
        wcOutputs && typeof wcOutputs === "object"
          ? Object.fromEntries(
              Object.entries(wcOutputs)
                .filter(([, def]: [string, any]) => def?.value != null)
                .map(([k, def]: [string, any]) => [k, String(def.value)]),
            )
          : undefined;

      // Recursively expand the called workflow
      const calledEntries = expandReusableJobsInternal(
        calledPath,
        repoRoot,
        remoteCache,
        depth + 1,
        visitedPaths,
      );

      const callerNeeds = parseNeeds(jobDef?.needs);

      // Prefix all entry IDs and needs with the caller job ID,
      // and attach inputs/outputs metadata
      const prefixed: ExpandedJobEntry[] = calledEntries.map((entry) => ({
        id: `${jobId}/${entry.id}`,
        workflowPath: entry.workflowPath,
        sourceTaskName: entry.sourceTaskName,
        needs: entry.needs.length === 0 ? callerNeeds : entry.needs.map((n) => `${jobId}/${n}`),
        inputs: callerWith,
        inputDefaults:
          inputDefaults && Object.keys(inputDefaults).length > 0 ? inputDefaults : undefined,
        workflowCallOutputDefs:
          workflowCallOutputDefs && Object.keys(workflowCallOutputDefs).length > 0
            ? workflowCallOutputDefs
            : undefined,
        callerJobId: jobId,
      }));

      // Compute terminals among the prefixed entries
      const prefixedIds = new Set(prefixed.map((e) => e.id));
      const depended = new Set<string>();
      for (const entry of prefixed) {
        for (const n of entry.needs) {
          if (prefixedIds.has(n)) {
            depended.add(n);
          }
        }
      }
      const terminals = prefixed.filter((e) => !depended.has(e.id)).map((e) => e.id);

      callerToTerminals.set(jobId, terminals);
      entries.push(...prefixed);
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

  visitedPaths.delete(resolvedPath);

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
