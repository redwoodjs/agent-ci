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
  input: { runId: string; phaseIdx: number }
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

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "micro_batches", r2KeysCount: r2Keys.length },
  });

  const env = context.env;
  const useLlm = true;

  const result = await runMicroBatchesAdapter(context, {
    runId: input.runId,
    r2Keys,
    useLlm,
    ports: {
      computeMicroItemsForChunkBatch: async ({ chunks, promptContext }) => {
        return (
          (await computeMicroMomentsForChunkBatch(chunks, {
            promptContext,
            logger: (msg, data) => {
              log
                .info("process.llm_retry", {
                  phase: "micro_batches",
                  msg,
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

