import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { runIngestDiffForKey } from "./core";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { ingestDiffRoutes } from "../../web/routes/documents";
import { DocumentsCard } from "../../web/ui/DocumentsCard";

export const ingest_diff_simulation: PipelineRegistryEntry = {
  phase: "ingest_diff" as const,
  label: "Ingest & Diff",

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
      const keys = (JSON.parse(pendingBatch.keys_json as string) as string[]) || [];
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;

      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_batch",
          payload: { phase: "ingest_diff", batchIndex: pendingBatch.batch_index, count: keys.length },
        });

        for (const k of keys) {
          await queue.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase: "ingest_diff",
            r2Key: k,
          });
        }
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
        const keys = (JSON.parse(b.keys_json as string) as string[]) || [];
        totalKeys += keys.length;
    }
    
    const countRow = (await db
      .selectFrom("simulation_run_documents")
      .select(({ fn }) => fn.count<number>("r2_key").as("count"))
      .where("run_id", "=", input.runId)
      .executeTakeFirst()) as any;
      
    const count = typeof countRow?.count === "number" ? countRow.count : Number(countRow?.count ?? 0);
    if (count < totalKeys) {
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
        context,
        runId: input.runId,
        r2Key: workUnit.r2Key,
      });

      const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
      const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
      const nextPhases = [...new Set([...currentPhases, "ingest_diff"])];

      await db
        .updateTable("simulation_run_documents")
        .set({
          changed: result.changed ? 1 : 0,
          document_hash: result.hash,
          processed_at: now,
          updated_at: now,
          processed_phases_json: nextPhases as any,
        })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
        
      await log.info("item.success", { phase: "ingest_diff", r2Key: workUnit.r2Key, changed: result.changed });
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      await log.error("item.error", { phase: "ingest_diff", r2Key: workUnit.r2Key, error: msg });
      
      await db
        .updateTable("simulation_run_documents")
        .set({
          error_json: JSON.stringify({ message: msg }) as any,
          updated_at: now,
        })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", workUnit.r2Key)
        .execute();
    }
  },

  web: {
    routes: ingestDiffRoutes,
    ui: {
      drilldown: DocumentsCard,
    },
  },

  async recoverZombies(context, input) {
    // Standard recovery
  }
};

registerPipeline(ingest_diff_simulation);
