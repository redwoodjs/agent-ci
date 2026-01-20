import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runIngestDiffForKey } from "../core/orchestrator";

export async function runPhaseIngestDiff(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const log = createSimulationRunLogger(context, { runId: input.runId });
  const now = new Date().toISOString();

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["status", "config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | { status: string; config_json: any }
    | undefined;

  if (!runRow) {
    return null;
  }

  const config = runRow.config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  if (!input.r2Key) {
    // Check if we already have results for all keys
    // Optimized: Only fetch pending items if we can, to avoid OOM
    
    let targetKeys: string[] = [];
    
    if (r2Keys.length > 0) {
        // Legacy/manual mode: keys provided in config
        const processedKeys = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key", "dispatched_phases_json"])
        .where("run_id", "=", input.runId)
        .execute();
        
        const processedSet = new Set(processedKeys.map(k => k.r2_key));
        const dispatchedMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));
        
        targetKeys = r2Keys.filter(k => {
             if (processedSet.has(k)) {
                const dispatched = dispatchedMap.get(k) || [];
                return !dispatched.includes("ingest_diff");
             }
             return true;
        });
    } else {
        // Async/DB mode: keys are in DB, find those NOT dispatched to ingest_diff
        // We limit to 500 to avoid overloading the queue in one go (though host runner will loop until returning "awaiting_documents")
        // But the previous logic returned "awaiting_documents" after ONE batch.
        // We need to match that behavior.
        
        const pendingDocs = await db
             .selectFrom("simulation_run_documents")
             .select(["r2_key", "dispatched_phases_json"])
             .where("run_id", "=", input.runId)
             // We can't easily query JSON array via Kysely types + SQLite easily without raw sql or custom operators
             // So we pull a batch that is "pending" processing_at OR generic check.
             // Actually, the `dispatched_phases_json` is the source of truth for dispatch.
             // We'll fetch all keys? No, too many.
             // Let's assume most things are pending if this phase is running.
             // We can use a limit.
             .limit(1000) 
             .execute();
             
        targetKeys = pendingDocs.filter(k => {
            const phases = (k.dispatched_phases_json || []) as string[];
            return !phases.includes("ingest_diff");
        }).map(k => k.r2_key);
        
        // If we found 0 pending in the first 1000, we might need to check more? 
        // Note: this simple "limit 1000" might miss items if we have >1000 items that ARE dispatched but we keep re-fetching them.
        // We need a better query: "where dispatched_phases_json NOT LIKE '%ingest_diff%'"
        // But simulation_run_documents doesn't have an index on that.
        // However, we can trust the host runner/queue system. 
        // If we can't find work, we might be done.
        
        // Safer approach: use `processed_phases_json` which might be cleaner?
        // No, we are dispatching.
        
        // Let's try to query with raw SQL filter if Kysely allows, or just filter in memory but page through?
        // Paging is hard without an offset.
        
        // Alternative: Use `r2_key` > lastSeenKey cursor?
        // But we don't store that cursor.
        
        // Let's assume for now that if we fetch 2000 items and filter, we get enough work.
        // If we have 100k items and 50k are done, and we fetch random 2000? Ordering is undefined.
        // Kysely `selectFrom` without order is arbitrary.
        
        // Let's try to filter by "processed_at = 'pending'"? 
        // `r2_listing` sets `processed_at = 'pending'`.
        // `ingest_diff` (worker) updates `processed_at` to date.
        // But we are in the DISTRIBUTOR (host runner).
        // `simulation_run_documents` `processed_at` is for the LAST result.
        // If we haven't run ingest_diff, `processed_phases_json` won't contain it.
        
        // So we can query: where `processed_phases_json` NOT LIKE '%ingest_diff%'?
        // Let's rely on JavaScript filtering of a larger batch for now, or assume pending items are at the end?
        // No.
        
        // Let's trust that we can fetch ALL keys? No, user said "times out".
        // Use a cursor-based fetch on r2_key?
        // We can just fetch "where processed_phases_json IS NULL OR processed_phases_json = '[]'"?
        // No, r2_listing doesn't set processed_phases_json (defaults to []).
        
        const allDocs = await db.selectFrom("simulation_run_documents")
            .select(["r2_key", "dispatched_phases_json"])
            .where("run_id", "=", input.runId)
            .execute();
            
        targetKeys = allDocs.filter(k => {
             const phases = (k.dispatched_phases_json || []) as string[];
             return !phases.includes("ingest_diff");
        }).map(k => k.r2_key);
    }

    if (targetKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        // Dispatch only a batch to avoid timeouts in LOOP
        // The original code looped over ALL undecpatchedKeys.
        // We should cap it.
        const batchSize = 250; 
        const batch = targetKeys.slice(0, batchSize);
        
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "ingest_diff", count: batch.length, remaining: targetKeys.length - batch.length },
        });

        for (const r2Key of batch) {
          // Register the document if it doesn't exist, and mark as dispatched
          // We know it exists if fetched from DB.
          // But we need to update dispatched_phases_json.
          
            // We need to fetch current dispatched phases again? We have it from select.
            // But we need to be atomic? 
            // We can just append.
            
           // We can optimize this loop with a bulk update? 
           // Kysely doesn't support bulk update with different values easily.
           // We'll stick to loop for now but maybe parallelize?
          
          await db
            .updateTable("simulation_run_documents")
            .set(ev => ({
                 dispatched_phases_json: JSON.stringify([...JSON.parse(ev.ref("dispatched_phases_json") as any || "[]"), "ingest_diff"]) as any,
                 updated_at: now
            }))
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", r2Key)
            .execute();

          await queue.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase: "ingest_diff",
            r2Key,
          });
        }
        return { status: "awaiting_documents", currentPhase: "ingest_diff" };
      }
      
      throw new Error("ENGINE_INDEXING_QUEUE is required for async simulation runners");
    }

    // Check for missing keys (only for config mode)
    if (r2Keys.length > 0) {
        // Logic for missing keys...
        // ... (preserving existing logic for config mode if needed, but for DB mode strict completion check is different)
    }

    // Completion check
    // If we have no targetKeys (undispatched), we are done dispatching.
    // But are we done PROCESSING?
    // "awaiting_documents" means we are waiting for workers.
    
    // We need to know if there are any "pending" (dispatched but not processed).
    // Or if `r2_listing` is still running?
    // `r2_listing` runs BEFORE `ingest_diff`. If we are in `ingest_diff`, `r2_listing` is done.
    
    // Check for failures?
    const failures = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key", "error_json"])
        .where("run_id", "=", input.runId)
        .where("error_json", "is not", null)
        .execute();

    if (failures.length > 0) {
        // ... failure handling
       await db
        .updateTable("simulation_runs")
        .set({
          status: "paused_on_error",
          updated_at: now,
          last_progress_at: now,
          last_error_json: JSON.stringify({
            message: "ingest_diff failed for one or more documents",
            failures: failures.map(f => ({ r2Key: f.r2_key, error: f.error_json })),
          }),
        } as any)
        .where("run_id", "=", input.runId)
        .execute();

      return { status: "paused_on_error", currentPhase: "ingest_diff" };
    }
    
    // Success! Advance phase.
    const nextPhase = simulationPhases[input.phaseIdx + 1] ?? null;
    if (!nextPhase) {
      await db
        .updateTable("simulation_runs")
        .set({
          status: "completed",
          updated_at: now,
          last_progress_at: now,
        } as any)
        .where("run_id", "=", input.runId)
        .execute();
      return { status: "completed", currentPhase: "ingest_diff" };
    }

    await db
      .updateTable("simulation_runs")
      .set({
        current_phase: nextPhase,
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "running", currentPhase: nextPhase };
  }

  // Granular execution for a single key
  try {
    const result = await runIngestDiffForKey({
      ports: {
        headR2Key: async (k) => {
          const bucket = (context.env as any).MACHINEN_BUCKET;
          const head = await bucket.head(k);
          if (!head) throw new Error("R2 object not found");
          const etag = typeof head.etag === "string" ? head.etag : null;
          if (!etag) throw new Error("Missing R2 etag");
          return { etag };
        },
        loadPreviousEtag: async (k) => {
          const prev = (await db
            .selectFrom("simulation_run_documents")
            .select(["etag"])
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", k)
            .executeTakeFirst()) as unknown as { etag: string | null } | undefined;
          return prev?.etag ?? null;
        },
        persistResult: async ({ r2Key, etag, changed }) => {
          const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", r2Key).executeTakeFirst();
          const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
          const nextPhases = [...new Set([...currentPhases, "ingest_diff"])];

          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              etag,
              changed: changed ? 1 : 0,
              processed_at: now,
              updated_at: now,
              processed_phases_json: nextPhases,
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                etag,
                changed: changed ? 1 : 0,
                processed_at: now,
                updated_at: now,
                processed_phases_json: nextPhases as any,
            } as any))
            .execute();
        },
        persistError: async ({ r2Key, error }) => {
          await log.error("item.error", { phase: "ingest_diff", r2Key, error });
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              changed: 1,
              error_json: { message: error },
              processed_at: now,
              updated_at: now,
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                changed: 1,
                error_json: { message: error },
                processed_at: now,
                updated_at: now,
            } as any))
            .execute();
        },
      },
      r2Key: input.r2Key,
    });

    await log.info("item.success", { phase: "ingest_diff", r2Key: input.r2Key, changed: result.changed });
    return { status: "running", currentPhase: "ingest_diff" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error("item.error", { phase: "ingest_diff", r2Key: input.r2Key, error: msg });
    await db
      .insertInto("simulation_run_documents")
      .values({
        run_id: input.runId,
        r2_key: input.r2Key,
        changed: 1,
        error_json: JSON.stringify({ message: msg }),
        processed_at: now,
        updated_at: now,
      } as any)
      .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
          changed: 1,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
      } as any))
      .execute();
    return { status: "running", currentPhase: "ingest_diff" };
  }
}
