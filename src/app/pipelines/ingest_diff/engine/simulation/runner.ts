import { registerPipeline, type PipelineRegistryEntry } from "../../../../engine/simulation/registry";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { runIngestDiffForKey } from "../core/orchestrator";
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
      const keys = (pendingBatch.keys_json as unknown as string[]) || [];
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;

      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_batch",
          payload: { phase: "ingest_diff", batchIndex: pendingBatch.batch_index, count: keys.length },
        });

        for (const k of keys) {
          // Initialize tracking row immediately so count(*) completion check works
          await db.insertInto("simulation_run_documents")
             .values({
                run_id: input.runId,
                r2_key: k,
                processed_at: now,
                updated_at: now,
                changed: 1, // Assume changed until proven otherwise
                processed_phases_json: JSON.stringify([]),
                dispatched_phases_json: JSON.stringify([]),
             } as any)
             .onConflict(oc => oc.doNothing())
             .execute();

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
        const keys = (b.keys_json as unknown as string[]) || [];
        totalKeys += keys.length;
    }
    
    const docs = await db
      .selectFrom("simulation_run_documents")
      .select(["processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
      
    const allProcessed = docs.length >= totalKeys && docs.every(d => {
        const processed = (d.processed_phases_json || []) as string[];
        return processed.includes("ingest_diff");
    });

    if (!allProcessed) {
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
            const row = await db.selectFrom("simulation_run_documents")
              .select("etag")
              .where("run_id", "=", input.runId)
              .where("r2_key", "=", k)
              .executeTakeFirst();
            return row?.etag ?? null;
          },
          persistResult: async (res) => {
              // We handle persistence below to include processing logic
          },
          persistError: async (err) => {
              // We handle persistence below
          }
        },
        r2Key: workUnit.r2Key,
      });

      const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", workUnit.r2Key).executeTakeFirst();
      const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
      const nextPhases = [...new Set([...currentPhases, "ingest_diff"])];

      await db
        .updateTable("simulation_run_documents")
        .set({
          changed: result.changed ? 1 : 0,
          document_hash: result.etag, // Storing etag as hash for now or fetch actual hash if needed
          processed_at: now,
          updated_at: now,
          processed_phases_json: nextPhases as any,
          etag: result.etag,
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
