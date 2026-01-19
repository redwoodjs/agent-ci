import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import type { SimulationMicroBatchCacheRow } from "../../../../engine/simulation/types";
import type { Document, IndexingHookContext } from "../../../../engine/types";
import {
  getMicroPromptContext,
  splitDocumentIntoChunks,
} from "../../../../engine/indexing/pluginPipeline";
import { getIndexingPlugins } from "../../../../engine/indexing/indexingPlugins";
import { chunkChunksForMicroComputation } from "../../../../engine/utils/chunkBatching";
import { sha256Hex } from "../../../../engine/utils/crypto";
import { computeMicroItemsWithoutLlm } from "../../../../engine/utils/microItems";
import {
  runMicroBatchesForDocument,
  type MicroBatchesOrchestratorPorts,
} from "../core/orchestrator";
import { planMicroBatches } from "../../../../engine/lib/phaseCores/microBatchesCore";
import { runIndexingDocumentPreparation } from "../../../../engine/indexing/documentPreparation";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "../../../../engine/momentGraphNamespace";

export async function runMicroBatchesAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    useLlm: boolean;
    ports: Pick<
      MicroBatchesOrchestratorPorts,
      | "computeMicroItemsForChunkBatch"
      | "getEmbeddings"
      | "getEmbedding"
      | "upsertMicroMomentsBatch"
    >;
    now: string;
    log: {
      error: (kind: string, payload: any) => Promise<void>;
      warn: (kind: string, payload: any) => Promise<void>;
      info: (kind: string, payload: any) => Promise<void>;
      debug: (kind: string, payload: any) => Promise<void>;
    };
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

    await input.log.info("item.start", {
      phase: "micro_batches",
      r2Key,
    });

    try {
      const prepared = await runIndexingDocumentPreparation({
        ports: {
          prepareSourceDocument: async ({ indexingContext }) =>
            await prepareSourceDocument(indexingContext),
          computeMomentGraphNamespaceForIndexing: async () => null,
          getMomentGraphNamespacePrefixFromEnv,
          applyMomentGraphNamespacePrefixValue: (
            baseNamespace: string,
            prefix: string | null
          ) =>
            applyMomentGraphNamespacePrefixValue(baseNamespace, prefix) ??
            baseNamespace,
          splitDocumentIntoChunks: async ({
            document,
            indexingContext,
            plugins,
          }) => {
            await input.log.info("process.splitting_chunks", {
              phase: "micro_batches",
              r2Key,
            });
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
        },
        r2Key,
        env,
        plugins,
        overrideNamespace: input.momentGraphNamespace,
        overridePrefix: input.momentGraphNamespacePrefix,
        indexingMode: "replay",
        forceRecollect: true,
      });

      if (prepared.chunks.length === 0) {
        continue;
      }

      const result = await runMicroBatchesForDocument({
        ports: {
          planMicroBatches: async (args) => {
            await input.log.info("process.planning_batches", {
              phase: "micro_batches",
              r2Key,
            });
            return planMicroBatches(args);
          },
          sha256Hex,
          getMicroPromptContext,
          loadMicroBatchCache: async ({ batchHash, promptContextHash }) => {
            await input.log.info("process.loading_cache", {
              phase: "micro_batches",
              batchHash,
            });
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
            chunks,
            batchIndex,
            promptContext,
          }) => {
            await input.log.info("process.storing_cache", {
              phase: "micro_batches",
              batchHash,
            });
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
          computeMicroItemsForChunkBatch: async (args) => {
            await input.log.info("process.computing_batch_start", {
              phase: "micro_batches",
              r2Key,
              chunks: args.chunks.length,
            });
            const res = await input.ports.computeMicroItemsForChunkBatch(args);
            await input.log.info("process.computing_batch_end", {
              phase: "micro_batches",
              r2Key,
              itemsCount: res.length,
            });
            return res;
          },
          fallbackMicroItemsForChunkBatch: ({ chunks }) =>
            computeMicroItemsWithoutLlm(chunks),
          getEmbeddings: input.ports.getEmbeddings,
          getEmbedding: input.ports.getEmbedding,
          upsertMicroMomentsBatch: async (args) => {
            await input.log.info("process.upserting_moments", {
              phase: "micro_batches",
              r2Key,
              count: args.microMoments.length,
            });
            return input.ports.upsertMicroMomentsBatch(args);
          },
        },
        document: prepared.document,
        indexingContext: prepared.indexingContext,
        plugins,
        chunkBatches: chunkChunksForMicroComputation(prepared.chunks, {
          maxBatchChars: chunkBatchMaxChars,
          maxChunkChars: chunkMaxChars,
          maxBatchItems: chunkBatchSize,
        }),
        now: input.now,
      });

      const computed = result.batches;

      for (const b of computed) {
        if (b.cached) {
          batchesCached++;
        } else {
          batchesComputed++;
        }

        await input.log.info("batch.success", {
          phase: "micro_batches",
          r2Key,
          batchIndex: b.batchIndex,
          cached: b.cached,
          items: b.microItems,
        });

        await db
          .insertInto("simulation_run_micro_batches")
          .values({
            run_id: input.runId,
            r2_key: r2Key,
            batch_index: b.batchIndex as any,
            batch_hash: b.batchHash,
            prompt_context_hash: b.promptContextHash,
            status: b.cached ? "cached" : "computed_llm",
            error_json: null,
            created_at: input.now,
            updated_at: input.now,
          } as any)
          .onConflict((oc) =>
            oc.columns(["run_id", "r2_key", "batch_index"]).doUpdateSet({
              batch_hash: b.batchHash,
              prompt_context_hash: b.promptContextHash,
              status: b.cached ? "cached" : "computed_llm",
              error_json: null,
              updated_at: input.now,
            } as any)
          )
          .execute();
      }

      await input.log.info("item.success", {
        phase: "micro_batches",
        r2Key,
        batchesCount: computed.length,
      });
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

