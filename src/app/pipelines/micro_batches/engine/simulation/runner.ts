import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runMicroBatchesAdapter } from "./adapter";
import { computeMicroMomentsForChunkBatch } from "../../../../engine/subjects/computeMicroMomentsForChunkBatch";
import { getEmbedding, getEmbeddings } from "../../../../engine/utils/vector";
import { upsertMicroMomentsBatch } from "../../../../engine/databases/momentGraph";

export async function runPhaseMicroBatches(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string; batchIndex?: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select([
      "config_json",
      "moment_graph_namespace",
      "moment_graph_namespace_prefix",
    ])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as any;

  if (!runRow) return null;

  const config = runRow.config_json ?? {};
  const r2KeysRaw = config?.r2Keys;
  const r2Keys = Array.isArray(r2KeysRaw) && r2KeysRaw.every((k: any) => typeof k === "string") ? (r2KeysRaw as string[]) : [];
  
  const momentGraphNamespace = runRow.moment_graph_namespace;
  const momentGraphNamespacePrefix = runRow.moment_graph_namespace_prefix;
  await log.info("debug.namespace", { phase: "micro_batches", momentGraphNamespace, momentGraphNamespacePrefix });

  if (!input.r2Key) {
    // Polling / Startup mode
    const changedDocs = await db.selectFrom("simulation_run_documents").select("r2_key").where("run_id", "=", input.runId).where("changed", "=", 1).where("error_json", "is", null).execute();
    const relevantR2Keys = changedDocs.map(d => d.r2_key);

    if (relevantR2Keys.length === 0) return advance(db, input.runId, input.phaseIdx, now);

    // Are there any batches still in 'enqueued' state for this run?
    const enqueuedCountRow = await db.selectFrom("simulation_run_micro_batches")
      .select(({ fn }) => fn.count<number>("r2_key").as("count"))
      .where("run_id", "=", input.runId)
      .where("status", "=", "enqueued")
      .executeTakeFirst();
    const enqueuedCount = Number(enqueuedCountRow?.count ?? 0);

    const processedKeys = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();

    const finishedSet = new Set(processedKeys.filter(k => ((k.processed_phases_json as any) || []).includes("micro_batches")).map(k => k.r2_key));
    const processedSet = new Set(processedKeys.map(k => k.r2_key));
    const dispatchMap = new Map(processedKeys.map(k => [k.r2_key, (k.dispatched_phases_json || []) as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !finishedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("micro_batches");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, { runId: input.runId, level: "info", kind: "phase.dispatch_docs", payload: { phase: "micro_batches", count: undecpatchedKeys.length } });
        for (const k of undecpatchedKeys) {
          const dispatched = (dispatchMap.get(k) || []) as string[];
          const nextDispatched = [...new Set([...dispatched, "micro_batches"])];
          
          await db
            .insertInto("simulation_run_documents")
            .values({
              run_id: input.runId,
              r2_key: k,
              changed: 1, // Must be 1 if we're here
              processed_at: "pending",
              updated_at: now,
              dispatched_phases_json: nextDispatched,
              processed_phases_json: [],
            } as any)
            .onConflict(oc => oc.columns(["run_id", "r2_key"]).doUpdateSet({
              dispatched_phases_json: nextDispatched,
              updated_at: now,
            } as any))
            .execute();

          await queue.send({ jobType: "simulation-document", runId: input.runId, phase: "micro_batches", r2Key: k });
        }
        return { status: "awaiting_documents", currentPhase: "micro_batches" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0 || enqueuedCount > 0) {
      return { status: "awaiting_documents", currentPhase: "micro_batches" };
    }

    // All documents have been started. Now check if any are still in "planned" state but not done? 
    // Actually, for micro_batches, the adapter enqueues BATCHES.
    // So we are done if ALL planned batches for ALL relevant docs are in 'computed_llm' or 'cached' state.
    // This is hard to check without planning. 
    // But we can assume if there are no more 'simulation-batch' jobs in the queue... 
    // Wait, we can't see the queue.
    
    // Simplification: the adapter marks a doc as done by inserting rows. 
    // If we wanted to be perfectly sure, we'd check if any batch still has status 'enqueued' (not implemented yet).
    // For now, let's assume if every doc has been started, we're progressing.
    // To avoid advancing too early, we might need a status check in the adapter.
    
    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution (for one document or one batch)
  const result = await runMicroBatchesAdapter(context, {
    runId: input.runId,
    r2Keys: [input.r2Key],
    useLlm: true,
    ports: {
      computeMicroItemsForChunkBatch: async ({ chunks, promptContext, batchIndex }) => {
        return (await computeMicroMomentsForChunkBatch(chunks, {
          promptContext,
          logger: (msg, data) => {
            log.info("process.llm_retry", { phase: "micro_batches", msg, batchIndex, ...data }).catch(() => {});
          },
        })) ?? [];
      },
      getEmbeddings: async (texts) => await getEmbeddings(texts),
      getEmbedding: async (text) => await getEmbedding(text),
      upsertMicroMomentsBatch: async ({ documentId, momentGraphNamespace, microMoments }) => {
        await upsertMicroMomentsBatch(documentId, microMoments as any, { env: context.env, momentGraphNamespace });
      },
    },
    now,
    log,
    momentGraphNamespace,
    momentGraphNamespacePrefix,
    batchIndex: input.batchIndex,
  });

  // If this was a full doc (not just a batch), mark as processed
  if (input.batchIndex === undefined) {
    const docMetadata = await db.selectFrom("simulation_run_documents").select("processed_phases_json").where("run_id", "=", input.runId).where("r2_key", "=", input.r2Key).executeTakeFirst();
    const currentPhases = (docMetadata?.processed_phases_json || []) as string[];
    const nextPhases = [...new Set([...currentPhases, "micro_batches"])];
    await db.updateTable("simulation_run_documents")
      .set({ processed_phases_json: nextPhases as any, updated_at: now })
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", input.r2Key)
      .execute();
  }

  return { status: "running", currentPhase: "micro_batches" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "micro_batches" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}

