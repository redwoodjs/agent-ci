import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { runIngestDiffForKey } from "../core/orchestrator";

export const ingest_diff_simulation: PipelineRegistryEntry = {
  phase: "ingest_diff" as const,
  label: "Ingest Diff",

  async onTick(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();

    // 1. Dispatch pending batches
    const pendingBatch = await db
      .selectFrom("simulation_run_r2_batches")
      .select(["batch_index", "keys_json"])
      .where("run_id", "=", input.runId)
      .where("processed", "=", 0)
      .limit(1)
      .executeTakeFirst();
      
    if (pendingBatch) {
      const keys = (pendingBatch.keys_json as unknown as string[]) || [];
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;

      await addSimulationRunEvent(context, {
        runId: input.runId,
        level: "info",
        kind: "phase.dispatch_batch",
        payload: { phase: "ingest_diff", batchIndex: pendingBatch.batch_index, count: keys.length },
      });

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
        await (queue as any).sendBatch(messages);
      }

      await db.updateTable("simulation_run_r2_batches")
        .set({ processed: 1, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("batch_index", "=", pendingBatch.batch_index)
        .execute();

      return { status: "awaiting_documents", currentPhase: "ingest_diff" };
    }

    // 2. Completion Check
    const batches = await db
      .selectFrom("simulation_run_r2_batches")
      .select("keys_json")
      .where("run_id", "=", input.runId)
      .execute();
      
    let totalKeys = 0;
    for (const b of batches) {
        totalKeys += ((b.keys_json as unknown as string[]) || []).length;
    }
    
    const countRow = await db
      .selectFrom("simulation_run_documents")
      .select(({ fn }) => fn.count<number>("r2_key").as("count"))
      .where("run_id", "=", input.runId)
      .executeTakeFirst();
      
    if (Number(countRow?.count ?? 0) < totalKeys) {
        return { status: "awaiting_documents", currentPhase: "ingest_diff" };
    }
    
    // Success! Advance phase.
    return { status: "running", currentPhase: "micro_batches" };
  },

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const log = createSimulationRunLogger(context, { runId: input.runId });
    const now = new Date().toISOString();
    const { workUnit } = input;

    if (workUnit.kind !== "document") return;

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
            const currentPhases = (docMetadata?.processed_phases_json ?? []) as string[];
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
                processed_phases_json: JSON.stringify(nextPhases) as any,
                dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
              } as any)
              .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                  etag,
                  changed: changed ? 1 : 0,
                  processed_at: now,
                  updated_at: now,
                  processed_phases_json: JSON.stringify(nextPhases) as any,
                  dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
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
                error_json: JSON.stringify({ message: error }) as any,
                processed_at: now,
                updated_at: now,
                dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
              } as any)
              .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
                  changed: 1,
                  error_json: JSON.stringify({ message: error }) as any,
                  processed_at: now,
                  updated_at: now,
                  dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
              } as any))
              .execute();
          },
        },
        r2Key: workUnit.r2Key,
      });

      await log.info("item.success", { phase: "ingest_diff", r2Key: workUnit.r2Key, changed: result.changed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", { phase: "ingest_diff", r2Key: workUnit.r2Key, error: msg });
      await db
        .insertInto("simulation_run_documents")
        .values({
          run_id: input.runId,
          r2_key: workUnit.r2Key,
          changed: 1,
          error_json: JSON.stringify({ message: msg }),
          processed_at: now,
          updated_at: now,
          dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
        } as any)
        .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
            changed: 1,
            error_json: JSON.stringify({ message: msg }),
            processed_at: now,
            updated_at: now,
            dispatched_phases_json: JSON.stringify(["ingest_diff"]) as any,
        } as any))
        .execute();
    }
  },

  async recoverZombies(context, input) {
    // Standard recovery
  }
};

registerPipeline(ingest_diff_simulation);
