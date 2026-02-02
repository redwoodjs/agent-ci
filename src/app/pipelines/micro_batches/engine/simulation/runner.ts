import { getSimulationDb } from "../../../../engine/simulation/db";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { runMicroBatchesAdapter } from "./adapter";
import { computeMicroMomentsForChunkBatch } from "../../../../engine/subjects/computeMicroMomentsForChunkBatch";
import { getEmbedding, getEmbeddings } from "../../../../engine/utils/vector";
import { upsertMicroMomentsBatch } from "../../../../engine/databases/momentGraph";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import {
  registerPipeline,
  type PipelineRegistryEntry,
} from "../../../../engine/simulation/registry";
import { microBatchesRoutes } from "../../web/routes/batches";
import { MicroBatchesCard } from "../../web/ui/MicroBatchesCard";
import { recoverMicroBatchZombies } from "./sweeper";

export const micro_batches_simulation: PipelineRegistryEntry = {
  phase: "micro_batches" as const,
  label: "Micro Batches",

  async onTick(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const isDev = !!process.env.VITE_IS_DEV_SERVER;
    const cooldownMs = isDev ? 30 * 1000 : 10 * 60 * 1000;
    const cooldownDate = new Date(Date.now() - cooldownMs).toISOString();

    // 1. Polling for undispatched Documents (Changed or Unchanged, we need to ensure they are processed for this run)
    const docs = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .where((eb: any) =>
        eb.or([
          eb("error_json", "is", null),
          eb("updated_at", "<", cooldownDate),
        ]),
      )
      .execute();

    const undispatchedDocs = docs.filter((doc) => {
      const processed = (doc.processed_phases_json || []) as string[];
      const dispatched = (doc.dispatched_phases_json || []) as string[];
      return (
        !processed.includes("micro_batches") &&
        !dispatched.includes("micro_batches")
      );
    });

    if (undispatchedDocs.length > 0) {
      await addSimulationRunEvent(context, {
        runId: input.runId,
        level: "info",
        kind: "host.dispatch.work",
        payload: {
          phase: "micro_batches",
          count: undispatchedDocs.length,
          sample: undispatchedDocs[0].r2_key,
        },
      });

      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      for (const doc of undispatchedDocs) {
        const dispatched = (doc.dispatched_phases_json || []) as string[];
        const nextDispatched = [...new Set([...dispatched, "micro_batches"])];
        await db
          .updateTable("simulation_run_documents")
          .set({
            dispatched_phases_json: nextDispatched as any,
            updated_at: now,
          })
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", doc.r2_key)
          .execute();
        await queue.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase: "micro_batches",
          r2Key: doc.r2_key,
        });
      }
      return { status: "awaiting_documents", currentPhase: "micro_batches" };
    }

    // 2. Poll for "Enqueued" Batches (specific to micro_batches)
    const enqueuedBatches = await db
      .selectFrom("simulation_run_micro_batches")
      .select(["r2_key", "batch_index"])
      .where("run_id", "=", input.runId)
      .where("status", "=", "enqueued")
      .where("updated_at", "<", cooldownDate)
      .execute();

    if (enqueuedBatches.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      for (const b of enqueuedBatches) {
        await db
          .updateTable("simulation_run_micro_batches")
          .set({ updated_at: now })
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", b.r2_key)
          .where("batch_index", "=", b.batch_index as any)
          .execute();
        await queue.send({
          jobType: "simulation-batch",
          runId: input.runId,
          phase: "micro_batches",
          r2Key: b.r2_key,
          batchIndex: b.batch_index,
        });
      }
      return { status: "awaiting_documents", currentPhase: "micro_batches" };
    }

    // 3. Check if everything is processed
    const totalDocs = await db
      .selectFrom("simulation_run_documents")
      .select(["processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();
    const allDocsDone = totalDocs.every((d) =>
      ((d.processed_phases_json || []) as string[]).includes("micro_batches"),
    );

    // Also check if any batches are still enqueued or failed
    const pendingBatches = await db
      .selectFrom("simulation_run_micro_batches")
      .select(({ fn }) => fn.count<number>("r2_key").as("count"))
      .where("run_id", "=", input.runId)
      .where("status", "in", ["enqueued", "failed"])
      .executeTakeFirst();

    if (allDocsDone && Number(pendingBatches?.count ?? 0) === 0) {
      return { status: "running", currentPhase: "macro_synthesis" }; // Advance
    }

    return { status: "awaiting_documents", currentPhase: "micro_batches" };
  },

  async onExecute(context, input) {
    const db = getSimulationDb(context);
    const now = new Date().toISOString();
    const { workUnit } = input;
    const r2Key = (workUnit as any).r2Key;
    const log = createSimulationRunLogger(context, { runId: input.runId, r2Key });

    const runRow = await db
      .selectFrom("simulation_runs")
      .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
      .where("run_id", "=", input.runId)
      .executeTakeFirst();
    if (!runRow) return;

    const batchIndex = (workUnit as any).batchIndex;

    const result = await runMicroBatchesAdapter(context, {
      runId: input.runId,
      r2Keys: [r2Key],
      useLlm: true,
      ports: {
        computeMicroItemsForChunkBatch: async ({
          chunks,
          promptContext,
          batchIndex,
        }) => {
          await context.heartbeat?.();
          const items = await computeMicroMomentsForChunkBatch(chunks, {
            promptContext,
            logger: (msg, data) => {
              context.heartbeat?.().catch(() => {});
              log
                .info("process.llm_retry", {
                  phase: "micro_batches",
                  msg,
                  batchIndex,
                  ...data,
                })
                .catch(() => {});
            },
          });
          await context.heartbeat?.();
          return items ?? [];
        },
        getEmbeddings: async (texts) => await getEmbeddings(texts),
        getEmbedding: async (text) => await getEmbedding(text),
        upsertMicroMomentsBatch: async ({
          documentId,
          momentGraphNamespace,
          microMoments,
        }) => {
          await upsertMicroMomentsBatch(documentId, microMoments as any, {
            env: context.env,
            momentGraphNamespace,
          });
        },
      },
      now,
      log,
      momentGraphNamespace: runRow.moment_graph_namespace,
      momentGraphNamespacePrefix: runRow.moment_graph_namespace_prefix,
      batchIndex: batchIndex,
    });

    if (result.failed > 0 && workUnit.kind === "document") {
      await db
        .updateTable("simulation_run_documents")
        .set({
          error_json: JSON.stringify(result.failures) as any,
          updated_at: now,
        })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .execute();
    }

    if (workUnit.kind === "document") {
      const docMetadata = await db
        .selectFrom("simulation_run_documents")
        .select("processed_phases_json")
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .executeTakeFirst();
      const currentPhases = (docMetadata?.processed_phases_json ||
        []) as string[];
      const nextPhases = [...new Set([...currentPhases, "micro_batches"])];
      await db
        .updateTable("simulation_run_documents")
        .set({ processed_phases_json: nextPhases as any, updated_at: now })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .execute();
    }
  },

  web: {
    routes: microBatchesRoutes,
    ui: {
      drilldown: MicroBatchesCard,
    },
  },

  recoverZombies: recoverMicroBatchZombies,
};

registerPipeline(micro_batches_simulation);
