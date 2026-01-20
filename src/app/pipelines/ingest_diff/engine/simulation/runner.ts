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
     return runIngestDiffWorker(context, input, db, log, now);
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
      const keys = JSON.parse(pendingBatch.keys_json) as string[];
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (!queue) throw new Error("ENGINE_INDEXING_QUEUE is required");

      await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_batch",
          payload: { phase: "ingest_diff", batchIndex: pendingBatch.batch_index, count: keys.length },
      });

      // Insert all keys into simulation_run_documents to track them
      // We chunk inserts to avoid variable limits (batch of 50)
      const chunkSize = 50;
      for (let i = 0; i < keys.length; i += chunkSize) {
          const chunk = keys.slice(i, i + chunkSize);
          await db
            .insertInto("simulation_run_documents")
            .values(chunk.map(k => ({
                run_id: input.runId,
                r2_key: k,
                changed: 0,
                processed_at: "pending",
                updated_at: now,
                dispatched_phases_json: JSON.stringify(["ingest_diff"]),
                processed_phases_json: JSON.stringify([]),
            } as any)))
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                dispatched_phases_json: JSON.stringify(["ingest_diff"]), // Mark as dispatched if existing
                updated_at: now
            } as any))
            .execute();
            
           // Dispatch to queue
           // We can parallelize this? Or just serial await? Serial is safer for now.
           // Actually Cloudflare Queue sendBatch? rwsdk doesn't expose it maybe?
           // Assuming serial send for now.
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

      // Return running to pick up next batch immediately or waiting?
      // "running" allows host runner to loop immediately.
      // But we also want to wait for "awaiting_documents".
      // Actually, if we just dispatched 1000 items, we should probably yield "awaiting_documents" 
      // so we don't dispatch 100,000 items into the queue instantly.
      // But "awaiting_documents" means "stop host runner until queue drains".
      // If we mark batch as processed, we are "done" with that batch.
      // If we return "awaiting_documents", host runner stops.
      // When does it wake up? When a worker finishes?
      // Workers send "simulation-advance".
      // So yes, returning "awaiting_documents" is correct to throttle dispatch.
      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
  }

  // Legacy/Manual Mode or Fallback cleanup
  if (legacyR2Keys.length > 0) {
      // (Existing logic for manual keys, simplified for brevity as user uses async mode mostly)
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
             const phases = JSON.parse((dispatchedMap.get(k) as any) || "[]");
             return !phases.includes("ingest_diff");
         }
         return true; // Not in DB yet
     });

     if (undecpatchedKeys.length > 0) {
        // Dispatch them...
        // Reuse batch logic ideally, but here just simple dispatch
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
                 const phases = processedSet.has(k) ? JSON.parse((dispatchedMap.get(k) as any) || "[]") : [];
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
  // If no pending batches and no pending legacy keys.
  
  // We should also check if any docs are *currently* processing (in queue).
  // We can't query queue size easily.
  // But we can check if `processed_phases_json` includes "ingest_diff" for all docs?
  // Or check `failures`
  
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

  // Are we truly done?
  // We just exhausted pending batches.
  // But maybe workers are still running.
  // If we return "completed" now, we move to next phase.
  // We need to ensure all docs have `processed_phases_json` containing `ingest_diff`.
  
  const pendingDocs = await db
      .selectFrom("simulation_run_documents")
      .select("r2_key")
      .where("run_id", "=", input.runId)
      // We want docs where ingest_diff is dispatched but NOT processed
      // Dispatched: in `dispatched_phases_json`
      // Processed: in `processed_phases_json`
      // This query is hard in SQL for JSON.
      // But we can approximate: if we just dispatched a batch and returned "awaiting_documents", we wouldn't be here.
      // We only reach here if NO pending batches are found.
      // And host runner only re-runs us if "simulation-advance" signal comes (meaning a worker finished).
      
      // If we have no pending batches, we might still have docs in flight.
      // How do we detect "all quiet"?
      // We can use a counter? Or just assume if we are here and no batches -> done?
      // No, because existing batches might be "processed" (fully dispatched) but their items are still in queue.
      
      // We need to query for "in_progress" items.
      // We can add a "status" column to documents? No migration.
      // `processed_at` = 'pending' is set on dispatch.
      // Worker updates `processed_at` timestamp.
      .where("processed_at", "=", "pending") 
      .limit(1)
      .execute();
      
  if (pendingDocs.length > 0) {
      // Still awaiting workers
      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
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
          const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", r2Key).executeTakeFirst();
          const currentPhases = JSON.parse((docMetadata?.processed_phases_json as any) || "[]");
          const nextPhases = JSON.stringify([...new Set([...currentPhases, "ingest_diff"])]);

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
