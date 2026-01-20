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

  // If input.r2Key is provided, this is a worker execution for a specific key
  if (input.r2Key) {
     return runIngestDiffWorker(context, { ...input, r2Key: input.r2Key }, db, log, now);
  }

  // Host Runner Logic
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
  const legacyR2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  // Check for pending batches first (Async Mode)
  const pendingBatch = await db
      .selectFrom("simulation_run_r2_batches")
      .select(["batch_index", "keys_json"])
      .where("run_id", "=", input.runId)
      .where("processed", "=", 0)
      .limit(1)
      .executeTakeFirst();
      
  if (pendingBatch) {
      const keys = pendingBatch.keys_json as unknown as string[];
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (!queue) throw new Error("ENGINE_INDEXING_QUEUE is required");

      await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_batch",
          payload: { phase: "ingest_diff", batchIndex: pendingBatch.batch_index, count: keys.length },
      });

      // Dispatch to queue - NO DB INSERT HERE
       // We can parallelize this? Or just serial await? Serial is safer for now.
       const chunkSize = 100;
       for (let i = 0; i < keys.length; i += chunkSize) {
           const chunk = keys.slice(i, i + chunkSize);
           for (const k of chunk) {
               await queue.send({
                jobType: "simulation-document",
                runId: input.runId,
                phase: "ingest_diff",
                r2Key: k,
              });
           }
       }

      // Mark batch as processed
      await db.updateTable("simulation_run_r2_batches")
        .set({ processed: 1, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("batch_index", "=", pendingBatch.batch_index)
        .execute();

      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
  }

  // Legacy/Manual Mode or Fallback cleanup
  if (legacyR2Keys.length > 0) {
      // (Existing logic for manual keys, simplified)
      // Check if manual keys are dispatched...
     const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
    
     const processedSet = new Set(processedKeys.map(k => k.r2_key));
     const dispatchedMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));
     
     const undecpatchedKeys = legacyR2Keys.filter(k => {
         if (processedSet.has(k)) {
             const phases = dispatchedMap.get(k) || [];
             return !phases.includes("ingest_diff");
         }
         return true; // Not in DB yet
     });

     if (undecpatchedKeys.length > 0) {
        // Dispatch them...
        const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
        if (queue) {
            const batch = undecpatchedKeys.slice(0, 100); // cap to 100
             await addSimulationRunEvent(context, {
                runId: input.runId,
                level: "info",
                kind: "phase.dispatch_docs",
                payload: { phase: "ingest_diff", count: batch.length },
             });
             
             for (const k of batch) {
                 // Note: For legacy keys, we MIGHT want to insert into DB to mark "dispatched"?
                 // But strictly, we can just let worker do it.
                 // However, legacy logic uses `dispatched_phases_json` to know what to filter.
                 // If we don't update DB here, `undecpatchedKeys` might include same keys again in next tick?
                 // But wait, `runAllSimulationRunAction` creates keys list in config.
                 // Host runner reads config.
                 // If we don't mark "dispatched", host runner loops forever?
                 // YES. Legacy logic relies on DB state to know what is dispatched.
                 
                 // So for LEGACY keys, we MUST update DB.
                 // But legacy keys list is usually small (manual testing).
                 // So we keep inserts here, but ensure batch is small.
                 
                 const phases = (processedSet.has(k) ? (dispatchedMap.get(k) || []) : []) as string[];
                 const nextPhases = JSON.stringify([...phases, "ingest_diff"]);
                 
                 await db
                    .insertInto("simulation_run_documents")
                    .values({
                        run_id: input.runId,
                        r2_key: k,
                        changed: 0,
                        processed_at: "pending",
                        updated_at: now,
                        dispatched_phases_json: nextPhases,
                        processed_phases_json: "[]",
                    } as any)
                    .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                        dispatched_phases_json: nextPhases as any,
                        updated_at: now
                    } as any))
                    .execute();
                    
                 await queue.send({
                    jobType: "simulation-document",
                    runId: input.runId,
                    phase: "ingest_diff",
                    r2Key: k,
                 });
             }
             return { status: "awaiting_documents", currentPhase: "ingest_diff" };
        }
     }
  }

  // Completion Check
  
  // 1. Are there any pending batches? (Checked above)
  
  // 2. Are there any active items in queue?
  // We can't check queue.
  // We can check if `processed_phases_json` includes `ingest_diff`.
  // BUT, since we don't pre-insert rows for batches, counting rows might be misleading if they haven't been created yet.
  // However, we only mark batch as processed AFTER dispatching.
  // So if batch is processed, messages are in queue.
  // Eventually workers will create rows.
  
  // So we need to wait until:
  // Count(rows with ingest_diff processed) == Total Expected Keys.
  
  // How to get Total Expected Keys?
  // Sum of all keys in all batches + legacy keys.
  
  const batches = await db
    .selectFrom("simulation_run_r2_batches")
    .select("keys_json")
    .where("run_id", "=", input.runId)
    .execute();
    
  let totalKeys = legacyR2Keys.length;
  for (const b of batches) {
      // rwsdk auto-parses keys_json
      const keys = (b.keys_json as unknown as string[]) || [];
      totalKeys += keys.length;
  }
  
  // Now count processed docs
  // Because processed_phases_json is JSON text, filtering in SQLite is hard.
  // But we can approximate:
  // If we just check `processed_phases_json` is not null/empty?
  // Or fetch all docs? (Expensive if 100k docs)
  
  // Better: Add a simpler check.
  // If we are here, all batches are processed (dispatched).
  // So we just need to wait for workers to finish.
  // We can rely on `last_progress_at`? No.
  
  // We can poll for *pending* rows?
  // But we don't have pending rows anymore (we removed inserts).
  // So we only have "rows that exist" (processed) or "rows that don't exist" (in queue).
  
  // So `select count(*) from simulation_run_documents where run_id = ...`
  // This count should equal `totalKeys`.
  // Once count matches, we are done.
  
  const { count } = await db
    .selectFrom("simulation_run_documents")
    .select(db.fn.count("r2_key").as("count"))
    .where("run_id", "=", input.runId)
    .executeTakeFirst() as { count: number };
    
  if (Number(count) < totalKeys) {
      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
  }
  
  // Double check failures
  const failures = await db
        .selectFrom("simulation_run_documents")
        .select(["r2_key", "error_json"])
        .where("run_id", "=", input.runId)
        .where("error_json", "is not", null)
        .execute();

  if (failures.length > 0) {
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
      await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", input.runId).execute();
      return { status: "completed", currentPhase: "ingest_diff" };
  }
  
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", input.runId).execute();
  return { status: "running", currentPhase: nextPhase };
}

async function runIngestDiffWorker(
  context: SimulationDbContext,
  input: { runId: string; r2Key: string },
  db: any,
  log: any,
  now: string
): Promise<{ status: string; currentPhase: string } | null> {
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
          // Note: Row might not exist yet if host runner skipped insert.
          const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", r2Key).executeTakeFirst();
          const currentPhases = (docMetadata?.processed_phases_json ?? []) as string[];
          const nextPhases = JSON.stringify([...new Set([...currentPhases, "ingest_diff"])]);

          // We use UPSERT, so safe to call insert
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
              dispatched_phases_json: JSON.stringify(["ingest_diff"]), // Mark as dispatched too
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                etag,
                changed: changed ? 1 : 0,
                processed_at: now, // Worker completion updates processed_at
                updated_at: now,
                processed_phases_json: nextPhases as any,
                dispatched_phases_json: JSON.stringify(["ingest_diff"]),
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
              dispatched_phases_json: JSON.stringify(["ingest_diff"]),
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                changed: 1,
                error_json: { message: error },
                processed_at: now,
                updated_at: now,
                dispatched_phases_json: JSON.stringify(["ingest_diff"]),
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
        dispatched_phases_json: JSON.stringify(["ingest_diff"]),
      } as any)
      .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
          changed: 1,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
          dispatched_phases_json: JSON.stringify(["ingest_diff"]),
      } as any))
      .execute();
    return { status: "running", currentPhase: "ingest_diff" };
  }
}
