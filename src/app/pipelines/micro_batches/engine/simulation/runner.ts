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

  if (!input.r2Key) {
    // Check if docs have already been dispatched for this phase
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

    if (!dispatchEvent) {
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

    // Check progress
    const finishedEvents = events.filter((e) => {
      if (e.kind !== "item.success" && e.kind !== "item.error") {
        return false;
      }
      const payload = JSON.parse(e.payload_json);
      return payload.phase === "micro_batches";
    });

    if (finishedEvents.length < r2Keys.length) {
      return { status: "running", currentPhase: "micro_batches" };
    }
  }

  const activeR2Keys = input.r2Key ? [input.r2Key] : r2Keys;

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { 
      phase: "micro_batches", 
      r2KeysCount: activeR2Keys.length,
      isGranular: !!input.r2Key 
    },
  });

  const env = context.env;
  const useLlm = true;

  const result = await runMicroBatchesAdapter(context, {
    runId: input.runId,
    r2Keys: activeR2Keys,
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
    deferToQueue: !input.r2Key && !input.batchIndex, // Defer to queue if we are starting the whole phase
  });

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: result.failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "micro_batches",
      useLlm,
      r2KeysCount: r2Keys.length,
      docsProcessed: result.docsProcessed,
      docsSkippedUnchanged: result.docsSkippedUnchanged,
      batchesComputed: result.batchesComputed,
      batchesCached: result.batchesCached,
      failed: result.failed,
    },
  });

  if (input.r2Key) {
    // If it was a granular run, we don't advance the phase here.
    if ((context.env as any).ENGINE_INDEXING_QUEUE) {
       await (context.env as any).ENGINE_INDEXING_QUEUE.send({
         jobType: "simulation-advance",
         runId: input.runId,
       });
    }

    return { status: "running", currentPhase: "micro_batches" };
  }

  if (result.failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "micro_batches failed for one or more documents",
          failures: result.failures,
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
