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
       // Use sendBatch for efficiency
       const chunkSize = 100;
       for (let i = 0; i < keys.length; i += chunkSize) {
           const chunk = keys.slice(i, i + chunkSize);
           const messages = chunk.map(k => ({
               body: {
                jobType: "simulation-document",
                runId: input.runId,
                phase: "ingest_diff",
                r2Key: k,
               }
           }));
           await queue.sendBatch(messages);
       }

      // Mark batch as processed
      await db.updateTable("simulation_run_r2_batches")
        .set({ processed: 1, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("batch_index", "=", pendingBatch.batch_index)
        .execute();

      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
  }

  // Completion Check
  
  // 1. Are there any pending batches? (Checked above)
  
  // 2. Are there any active items in queue?
  // We check this by comparing the total expected keys from all batches to the count of processed keys.
  
  const batches = await db
    .selectFrom("simulation_run_r2_batches")
    .select("keys_json")
    .where("run_id", "=", input.runId)
    .execute();
    
  let totalKeys = 0;
  for (const b of batches) {
      const keys = (b.keys_json as unknown as string[]) || [];
      totalKeys += keys.length;
  }
  
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
