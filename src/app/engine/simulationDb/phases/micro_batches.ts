import type { SimulationDbContext } from "../types";
import { getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";
import {
  chunkChunksForMicroComputation,
  computeMicroItemsWithoutLlm,
  getIndexingPlugins,
  getMicroPromptContext,
  prepareDocumentForR2Key,
  sha256Hex,
  splitDocumentIntoChunks,
} from "../phaseUtils";
import { computeMicroMomentsForChunkBatch } from "../../subjects/computeMicroMomentsForChunkBatch";
import type { SimulationMicroBatchCacheRow } from "../types";
import { planMicroBatches } from "../../phaseCores/micro_batches_core";

export async function runPhaseMicroBatches(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
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

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "micro_batches", r2KeysCount: r2Keys.length },
  });

  const env = context.env;
  const useLlm =
    String((env as any).SIMULATION_MICRO_BATCH_USE_LLM ?? "") === "1";

  const plugins = getIndexingPlugins(env);

  let docsProcessed = 0;
  let docsSkippedUnchanged = 0;
  let batchesComputed = 0;
  let batchesCached = 0;
  let failed = 0;

  const failures: Array<{ r2Key: string; error: string }> = [];

  for (const r2Key of r2Keys) {
    const docState = (await db
      .selectFrom("simulation_run_documents")
      .select(["changed", "error_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | { changed: number; error_json: any }
      | undefined;

    const hadError = Boolean((docState as any)?.error_json);
    const changedFlag = Number((docState as any)?.changed ?? 1) !== 0;

    if (hadError) {
      failed++;
      failures.push({ r2Key, error: "ingest_diff error" });
      continue;
    }

    if (!changedFlag) {
      docsSkippedUnchanged++;
      continue;
    }

    docsProcessed++;

    try {
      const { document, indexingContext } = await prepareDocumentForR2Key(
        r2Key,
        env,
        plugins
      );
      const chunks = await splitDocumentIntoChunks(
        document,
        indexingContext,
        plugins
      );

      const chunkBatchSizeRaw = (env as any).MICRO_MOMENT_CHUNK_BATCH_SIZE;
      const chunkBatchMaxCharsRaw = (env as any)
        .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
      const chunkMaxCharsRaw = (env as any).MICRO_MOMENT_CHUNK_MAX_CHARS;

      const chunkBatchSize =
        typeof chunkBatchSizeRaw === "string"
          ? Number.parseInt(chunkBatchSizeRaw, 10)
          : typeof chunkBatchSizeRaw === "number"
          ? chunkBatchSizeRaw
          : 10;
      const chunkBatchMaxChars =
        typeof chunkBatchMaxCharsRaw === "string"
          ? Number.parseInt(chunkBatchMaxCharsRaw, 10)
          : typeof chunkBatchMaxCharsRaw === "number"
          ? chunkBatchMaxCharsRaw
          : 10_000;
      const chunkMaxChars =
        typeof chunkMaxCharsRaw === "string"
          ? Number.parseInt(chunkMaxCharsRaw, 10)
          : typeof chunkMaxCharsRaw === "number"
          ? chunkMaxCharsRaw
          : 2_000;

      const chunkBatches = chunkChunksForMicroComputation(chunks, {
        maxBatchChars: chunkBatchMaxChars,
        maxChunkChars: chunkMaxChars,
        maxBatchItems: chunkBatchSize,
      });

      const planned = await planMicroBatches({
        document,
        indexingContext,
        plugins,
        chunkBatches,
        sha256Hex,
        getMicroPromptContext,
      });

      for (const p of planned) {
        const batchIndex = p.batchIndex;
        const batchHash = p.batchHash;
        const promptContext = p.promptContext;
        const promptContextHash = p.promptContextHash;
        const batchChunks = p.chunks;

        const cached = (await db
          .selectFrom("simulation_micro_batch_cache")
          .select(["micro_items_json"])
          .where("batch_hash", "=", batchHash)
          .where("prompt_context_hash", "=", promptContextHash)
          .executeTakeFirst()) as unknown as
          | SimulationMicroBatchCacheRow
          | undefined;

        if (cached) {
          batchesCached++;
          await db
            .insertInto("simulation_run_micro_batches")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              batch_index: batchIndex as any,
              batch_hash: batchHash,
              prompt_context_hash: promptContextHash,
              status: "cached",
              error_json: null,
              created_at: now,
              updated_at: now,
            } as any)
            .onConflict((oc) =>
              oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
                batch_hash: batchHash,
                prompt_context_hash: promptContextHash,
                status: "cached",
                error_json: null,
                updated_at: now,
              } as any)
            )
            .execute();
          continue;
        }

        let microItems: string[] = [];
        if (useLlm) {
          microItems =
            (await computeMicroMomentsForChunkBatch(batchChunks, {
              promptContext,
            })) ?? [];
        }

        if (microItems.length === 0) {
          microItems = computeMicroItemsWithoutLlm(batchChunks);
        }

        await db
          .insertInto("simulation_micro_batch_cache")
          .values({
            batch_hash: batchHash,
            prompt_context_hash: promptContextHash,
            micro_items_json: JSON.stringify(microItems),
            created_at: now,
            updated_at: now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["batch_hash", "prompt_context_hash"]).doUpdateSet({
              micro_items_json: JSON.stringify(microItems),
              updated_at: now,
            } as any)
          )
          .execute();

        batchesComputed++;

        await db
          .insertInto("simulation_run_micro_batches")
          .values({
            run_id: input.runId,
            r2_key: r2Key,
            batch_index: batchIndex as any,
            batch_hash: batchHash,
            prompt_context_hash: promptContextHash,
            status: useLlm ? "computed_llm" : "computed_fallback",
            error_json: null,
            created_at: now,
            updated_at: now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
              batch_hash: batchHash,
              prompt_context_hash: promptContextHash,
              status: useLlm ? "computed_llm" : "computed_fallback",
              error_json: null,
              updated_at: now,
            } as any)
          )
          .execute();
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "micro_batches",
        r2Key,
        error: msg,
      });
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "micro_batches",
      useLlm,
      r2KeysCount: r2Keys.length,
      docsProcessed,
      docsSkippedUnchanged,
      batchesComputed,
      batchesCached,
      failed,
    },
  });

  if (failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "micro_batches failed for one or more documents",
          failures,
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
