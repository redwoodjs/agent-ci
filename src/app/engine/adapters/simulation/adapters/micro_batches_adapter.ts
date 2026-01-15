import type { SimulationDbContext } from "../types";
import { getSimulationDb } from "../db";
import type { SimulationMicroBatchCacheRow } from "../types";
import type { Document, IndexingHookContext } from "../../../types";
import {
  getMicroPromptContext,
  splitDocumentIntoChunks,
} from "../../../indexing/pluginPipeline";
import { getIndexingPlugins } from "../../../indexing/indexingPlugins";
import { chunkChunksForMicroComputation } from "../../../utils/chunkBatching";
import { sha256Hex } from "../../../utils/crypto";
import { computeMicroItemsWithoutLlm } from "../../../utils/microItems";
import { computeMicroMomentsForChunkBatch } from "../../../subjects/computeMicroMomentsForChunkBatch";
import { computeMicroBatchesForDocument } from "../../../core/indexing/micro_batches_orchestrator";
import { planMicroBatches } from "../../../lib/phaseCores/micro_batches_core";
import { runPhaseADocumentPreparation } from "../../../core/indexing/phase_a_orchestrator";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "../../../momentGraphNamespace";

export async function runMicroBatchesAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    useLlm: boolean;
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
    momentGraphNamespace: string | null;
    momentGraphNamespacePrefix: string | null;
  }
): Promise<{
  docsProcessed: number;
  docsSkippedUnchanged: number;
  batchesComputed: number;
  batchesCached: number;
  failed: number;
  failures: Array<{ r2Key: string; error: string }>;
}> {
  const db = getSimulationDb(context);
  const env = context.env;
  const plugins = getIndexingPlugins(env);

  const chunkBatchSizeRaw = (env as any).MICRO_MOMENT_CHUNK_BATCH_SIZE;
  const chunkBatchMaxCharsRaw = (env as any).MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
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

  let docsProcessed = 0;
  let docsSkippedUnchanged = 0;
  let batchesComputed = 0;
  let batchesCached = 0;
  let failed = 0;
  const failures: Array<{ r2Key: string; error: string }> = [];

  async function prepareSourceDocument(
    indexingContext: IndexingHookContext
  ): Promise<Document> {
    for (const plugin of plugins) {
      const result = await plugin.prepareSourceDocument?.(indexingContext);
      if (result) {
        return result;
      }
    }
    throw new Error("No plugin could prepare document");
  }

  for (const r2Key of input.r2Keys) {
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
      const phaseA = await runPhaseADocumentPreparation({
        ports: {
          prepareSourceDocument: async ({ indexingContext }) =>
            await prepareSourceDocument(indexingContext),
          computeMomentGraphNamespaceForIndexing: async () => null,
          getMomentGraphNamespacePrefixFromEnv,
          applyMomentGraphNamespacePrefixValue,
          splitDocumentIntoChunks: async ({
            document,
            indexingContext,
            plugins,
          }) => {
            try {
              return await splitDocumentIntoChunks(
                document,
                indexingContext,
                plugins
              );
            } catch (e) {
              const msg = String((e as any)?.message ?? "");
              if (msg === "No plugin could split document into chunks") {
                return [];
              }
              throw e;
            }
          },
          loadProcessedChunkHashes: async () => [],
          chunkChunksForMicroComputation: ({ chunks, ...opts }) =>
            chunkChunksForMicroComputation(chunks, opts),
        },
        r2Key,
        env,
        plugins,
        overrideNamespace: input.momentGraphNamespace,
        overridePrefix: input.momentGraphNamespacePrefix,
        indexingMode: "replay",
        forceRecollect: true,
        microBatching: {
          maxBatchChars: chunkBatchMaxChars,
          maxChunkChars: chunkMaxChars,
          maxBatchItems: chunkBatchSize,
        },
      });

      if (phaseA.chunks.length === 0) {
        continue;
      }

      const computed = await computeMicroBatchesForDocument({
        ports: {
          planMicroBatches,
          sha256Hex,
          getMicroPromptContext,
          loadMicroBatchCache: async ({ batchHash, promptContextHash }) => {
            const cached = (await db
              .selectFrom("simulation_micro_batch_cache")
              .select(["micro_items_json"])
              .where("batch_hash", "=", batchHash)
              .where("prompt_context_hash", "=", promptContextHash)
              .executeTakeFirst()) as unknown as
              | SimulationMicroBatchCacheRow
              | undefined;

            const items =
              (cached as any)?.micro_items_json &&
              Array.isArray((cached as any).micro_items_json)
                ? ((cached as any).micro_items_json as any[])
                : [];
            const asStrings = items
              .filter((x) => typeof x === "string")
              .map((x) => (x as string).trim())
              .filter(Boolean);

            if (asStrings.length === 0) {
              return null;
            }
            return { microItems: asStrings };
          },
          storeMicroBatchCache: async ({
            batchHash,
            promptContextHash,
            microItems,
          }) => {
            await db
              .insertInto("simulation_micro_batch_cache")
              .values({
                batch_hash: batchHash,
                prompt_context_hash: promptContextHash,
                micro_items_json: JSON.stringify(microItems),
                created_at: input.now,
                updated_at: input.now,
              } as any)
              .onConflict((oc) =>
                oc.columns(["batch_hash", "prompt_context_hash"]).doUpdateSet({
                  micro_items_json: JSON.stringify(microItems),
                  updated_at: input.now,
                } as any)
              )
              .execute();
          },
          computeMicroItemsForChunkBatch: async ({ chunks, promptContext }) => {
            if (!input.useLlm) {
              return [];
            }
            return (
              (await computeMicroMomentsForChunkBatch(chunks, {
                promptContext,
              })) ?? []
            );
          },
          fallbackMicroItemsForChunkBatch: ({ chunks }) =>
            computeMicroItemsWithoutLlm(chunks),
        },
        document: phaseA.document,
        indexingContext: phaseA.indexingContext,
        plugins,
        chunkBatches: phaseA.chunkBatches,
      });

      for (const b of computed) {
        if (b.cached) {
          batchesCached++;
        } else {
          batchesComputed++;
        }

        await db
          .insertInto("simulation_run_micro_batches")
          .values({
            run_id: input.runId,
            r2_key: r2Key,
            batch_index: b.batchIndex as any,
            batch_hash: b.batchHash,
            prompt_context_hash: b.promptContextHash,
            status: b.cached
              ? "cached"
              : input.useLlm
              ? "computed_llm"
              : "computed_fallback",
            error_json: null,
            created_at: input.now,
            updated_at: input.now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
              batch_hash: b.batchHash,
              prompt_context_hash: b.promptContextHash,
              status: b.cached
                ? "cached"
                : input.useLlm
                ? "computed_llm"
                : "computed_fallback",
              error_json: null,
              updated_at: input.now,
            } as any)
          )
          .execute();
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await input.log.error("item.error", {
        phase: "micro_batches",
        r2Key,
        error: msg,
      });
    }
  }

  return {
    docsProcessed,
    docsSkippedUnchanged,
    batchesComputed,
    batchesCached,
    failed,
    failures,
  };
}
