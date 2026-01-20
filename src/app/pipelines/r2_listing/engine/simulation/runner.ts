import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { simulationPhases } from "../../../../engine/simulation/types";

export async function runPhaseR2Listing(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();

  // Load run config
  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as { config_json: any } | undefined;

  if (!runRow) {
    return null;
  }

  const config = runRow.config_json || {};
  const r2ListConfig = config.r2List;

  // If no r2List config, this phase is a no-op (maybe manually provided keys?)
  // We just advance to next phase.
  if (!r2ListConfig) {
    const nextPhase = simulationPhases[input.phaseIdx + 1];
    if (nextPhase) {
      await db
        .updateTable("simulation_runs")
        .set({
          current_phase: nextPhase,
          updated_at: now,
        } as any)
        .where("run_id", "=", input.runId)
        .execute();
      return { status: "running", currentPhase: nextPhase };
    }
    return { status: "completed", currentPhase: "r2_listing" };
  }

  // Listing logic
  const bucket = (context.env as any).MACHINEN_BUCKET as R2Bucket;
  if (!bucket) {
    throw new Error("MACHINEN_BUCKET not found in env");
  }

  // r2ListConfig structure:
  // {
  //   targetPrefixes: string[];
  //   limitPerPage: number;
  //   maxPages: number; (global limit, simplified)
  //   
  //   // State
  //   currentPrefixIdx: number;
  //   cursor?: string;
  //   pagesProcessed: number;
  // }

  // Initialize state if needed
  if (typeof r2ListConfig.currentPrefixIdx !== "number") {
    r2ListConfig.currentPrefixIdx = 0;
    r2ListConfig.pagesProcessed = 0;
  }

  const prefixes = Array.isArray(r2ListConfig.targetPrefixes) 
    ? r2ListConfig.targetPrefixes 
    : [];
  
  const limit = r2ListConfig.limitPerPage || 200;
  const maxPages = r2ListConfig.maxPages || 1000;

  if (r2ListConfig.currentPrefixIdx >= prefixes.length || r2ListConfig.pagesProcessed >= maxPages) {
    // Done listing
     const nextPhase = simulationPhases[input.phaseIdx + 1];
    if (nextPhase) {
      await db
        .updateTable("simulation_runs")
        .set({
          current_phase: nextPhase,
          updated_at: now,
        } as any)
        .where("run_id", "=", input.runId)
        .execute();
      return { status: "running", currentPhase: nextPhase };
    }
    return { status: "completed", currentPhase: "r2_listing" };
  }

  const currentPrefix = prefixes[r2ListConfig.currentPrefixIdx];
  const cursor = r2ListConfig.cursor;

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.r2_list_page",
    payload: { prefix: currentPrefix, cursor },
  });

  const listOpts: R2ListOptions = {
    prefix: currentPrefix,
    limit,
    cursor,
  };

  const result = await bucket.list(listOpts);
  const keys = result.objects.map(o => o.key).filter(k => !!k);
  
  // Filtering logic (similar to simulation-actions.ts)
  const isGithubIssue = (k: string) => k.startsWith("github/") && k.includes("/issues/") && k.endsWith("/latest.json");
  const isGithubPr = (k: string) => k.startsWith("github/") && k.includes("/pull-requests/") && k.endsWith("/latest.json");
  const isDiscord = (k: string) => k.startsWith("discord/");
  const isCursor = (k: string) => k.startsWith("cursor/conversations/");
  const filterSupported = (k: string) => isGithubIssue(k) || isGithubPr(k) || isDiscord(k) || isCursor(k);

  const validKeys = keys.filter(filterSupported);

  // Batch insert into simulation_run_documents
  if (validKeys.length > 0) {
     // We define 50 items per chunk for insert to avoid statement limits if needed, but 200 checks is fine
     // Actually validKeys can be up to 1000 if limit is high. 
     // We should chunk installs.
     const chunkSize = 50;
     for (let i = 0; i < validKeys.length; i += chunkSize) {
        const chunk = validKeys.slice(i, i + chunkSize);
        await db
        .insertInto("simulation_run_documents")
        .values(chunk.map(k => ({
            run_id: input.runId,
            r2_key: k,
            changed: 0,
            processed_at: "pending",
            updated_at: now,
            dispatched_phases_json: [], // Not dispatched yet
            processed_phases_json: [],
        } as any)))
        // Ignore conflicts (if key already exists, we just want to ensure it's there)
        // Actually if it exists, we preserve its state? Or do we reset? 
        // For backfill, we might want to respect existing state if we are resuming?
        // Safe to ignore.
        .onConflict(oc => oc.columns(["run_id", "r2_key"]).doNothing())
        .execute();
     }
  }

  // Update State
  let nextCursor: string | undefined = undefined;
  let nextPrefixIdx = r2ListConfig.currentPrefixIdx;
  
  if (result.truncated) {
    nextCursor = result.cursor;
  } else {
    // Move to next prefix
    nextPrefixIdx++;
    nextCursor = undefined;
  }
  
  const nextConfig = {
    ...config,
    r2List: {
        ...r2ListConfig,
        currentPrefixIdx: nextPrefixIdx,
        cursor: nextCursor,
        pagesProcessed: r2ListConfig.pagesProcessed + 1,
    }
  };

  await db.updateTable("simulation_runs")
    .set({
        config_json: JSON.stringify(nextConfig),
        updated_at: now,
        last_progress_at: now,
    } as any)
    .where("run_id", "=", input.runId)
    .execute();

  // If we still have more work (prefix idx within range or truncated), we return running to loop.
  // The host runner will re-call us.
  
  if (nextPrefixIdx < prefixes.length || result.truncated) {
     return { status: "running", currentPhase: "r2_listing" };
  } else {
     // Done
     const nextPhase = simulationPhases[input.phaseIdx + 1];
     if (nextPhase) {
       await db
         .updateTable("simulation_runs")
         .set({
             current_phase: nextPhase,
             updated_at: now,
         } as any)
         .where("run_id", "=", input.runId)
         .execute();
        return { status: "running", currentPhase: nextPhase };
     }
     return { status: "completed", currentPhase: "r2_listing" };
  }
}
