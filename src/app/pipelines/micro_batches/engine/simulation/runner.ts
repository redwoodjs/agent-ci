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
    .executeTakeFirst()) as unknown as { config_json: any } | undefined;

  if (!runRow) {
    return null;
  }

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];
  const momentGraphNamespace =
    typeof (runRow as any)?.moment_graph_namespace === "string"
      ? ((runRow as any).moment_graph_namespace as string)
      : null;
  const momentGraphNamespacePrefix =
    typeof (runRow as any)?.moment_graph_namespace_prefix === "string"
      ? ((runRow as any).moment_graph_namespace_prefix as string)
      : null;

  const events = (await db
    .selectFrom("simulation_run_events")
    .select(["kind", "payload_json"])
    .where("run_id", "=", input.runId)
    .where("kind", "in", ["phase.dispatch_docs", "item.success", "item.error"])
    .execute()) as Array<{ kind: string; payload_json: any }>;

  const dispatchEvent = events.find(
    (e) =>
      e.kind === "phase.dispatch_docs" &&
      JSON.parse(e.payload_json).phase === "micro_batches"
  );

  // --- CASE 1: Granular Document Processing ---
  if (input.r2Key) {
    await addSimulationRunEvent(context, {
      runId: input.runId,
      level: "info",
      kind: "phase.start",
      payload: { 
        phase: "micro_batches", 
        r2KeysCount: 1,
        isGranular: true,
        r2Key: input.r2Key
      },
    });

    const env = context.env;
    const useLlm = true;

    const result = await runMicroBatchesAdapter(context, {
      runId: input.runId,
      r2Keys: [input.r2Key],
      useLlm,
      ports: {
        computeMicroItemsForChunkBatch: async ({ chunks, promptContext, batchIndex }) => {
          return (
            (await computeMicroMomentsForChunkBatch(chunks, {
              promptContext,
              logger: (msg, data) => {
                log
                  .info("process.llm_retry", {
                    phase: "micro_batches",
                    msg,
                    batchIndex,
                    ...data,
                  })
                  .catch(() => {});
              },
            })) ?? []
          );
        },
        getEmbeddings: async (texts) => await getEmbeddings(texts),
        getEmbedding: async (text) => await getEmbedding(text),
        upsertMicroMomentsBatch: async ({
          documentId,
          momentGraphNamespace,
          microMoments,
        }) => {
          await upsertMicroMomentsBatch(documentId, microMoments as any, {
            env,
            momentGraphNamespace,
          });
        },
      },
      now,
      log,
      momentGraphNamespace,
      momentGraphNamespacePrefix,
      batchIndex: input.batchIndex,
      deferToQueue: !input.batchIndex, // Defer to queue if we are processing a whole document
    });

    // Optional: Trigger an advance attempt just in case this was the last doc
    if ((context.env as any).ENGINE_INDEXING_QUEUE) {
       await (context.env as any).ENGINE_INDEXING_QUEUE.send({
         jobType: "simulation-advance",
         runId: input.runId,
       });
    }

    return { status: "running", currentPhase: "micro_batches" };
  }

  // --- CASE 2: Phase Control (Non-granular) ---
  if (!dispatchEvent) {
    // Stage A: Start of phase - Dispatch all docs
    const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
    if (queue && r2Keys.length > 0) {
      await addSimulationRunEvent(context, {
        runId: input.runId,
        level: "info",
        kind: "phase.dispatch_docs",
        payload: { phase: "micro_batches", count: r2Keys.length },
      });

      for (const r2Key of r2Keys) {
        await queue.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase: "micro_batches",
          r2Key,
        });
      }
      return { status: "running", currentPhase: "micro_batches" };
    }
  }

  // Stage B: Check progress
  const finishedEvents = events.filter((e) => {
    if (e.kind !== "item.success" && e.kind !== "item.error") {
      return false;
    }
    const payload = JSON.parse(e.payload_json);
    return payload.phase === "micro_batches";
  });

  if (finishedEvents.length < r2Keys.length) {
    // Still working
    return { status: "running", currentPhase: "micro_batches" };
  }

  // Stage C: Phase Completion logic
  const failedDocs = finishedEvents.filter(e => e.kind === 'item.error').length;
  const successes = finishedEvents.filter(e => e.kind === 'item.success');
  
  // Aggregate stats from successes if needed
  let docsSkippedUnchanged = 0;
  for (const e of successes) {
     const payload = JSON.parse(e.payload_json);
     if (payload.skipped) {
        docsSkippedUnchanged++;
     }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failedDocs > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "micro_batches",
      r2KeysCount: r2Keys.length,
      docsProcessed: finishedEvents.length - docsSkippedUnchanged,
      docsSkippedUnchanged,
      failed: failedDocs,
    },
  });

  if (failedDocs > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "micro_batches failed for one or more documents",
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "micro_batches" };
  }

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
    return { status: "completed", currentPhase: "micro_batches" };
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
