import { Phase, PipelineContext, Plugin, Document } from "../../engine/runtime/types";
import { runMicroBatchesForDocument } from "./engine/core/orchestrator";
import {
  runFirstMatchHook,
  splitDocumentIntoChunks,
} from "../../engine/indexing/pluginPipeline";
import { chunkChunksForMicroComputation } from "../../engine/utils/chunkBatching";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "../../engine/momentGraphNamespace";

export const MicroBatchesPhase: Phase<string, any> = {
  name: "micro_batches",
  next: "macro_synthesis",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Prepare Document
    const document = await runFirstMatchHook<Document>(
      context.plugins,
      (plugin: Plugin) => plugin.prepareSourceDocument?.(context)
    );

    if (!document) {
      throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
    }

    // Namespace Logic
    let baseNamespace: string | null = null;
    for (const plugin of context.plugins) {
      const ns = await plugin.scoping?.computeMomentGraphNamespaceForIndexing?.(
        document,
        context
      );
      if (ns) {
        baseNamespace = ns;
        break;
      }
    }

    const envPrefix = getMomentGraphNamespacePrefixFromEnv(context.env);
    const effectiveNamespace =
      applyMomentGraphNamespacePrefixValue(baseNamespace ?? "", envPrefix) ??
      baseNamespace;

    const effectiveContext = {
      ...context,
      momentGraphNamespace: effectiveNamespace,
    };

    // 2. Split & Process All Chunks
    const chunks = await splitDocumentIntoChunks(
      document,
      effectiveContext,
      context.plugins
    );

    if (chunks.length === 0) {
      return { batches: [], microMoments: [] };
    }

    // 3. Batch
    const chunkBatchSizeRaw = (context.env as any).MICRO_MOMENT_CHUNK_BATCH_SIZE;
    const chunkBatchMaxCharsRaw = (context.env as any)
      .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
    const chunkMaxCharsRaw = (context.env as any).MICRO_MOMENT_CHUNK_MAX_CHARS;

    const chunkBatchSize = Number(chunkBatchSizeRaw) || 10;
    const chunkBatchMaxChars = Number(chunkBatchMaxCharsRaw) || 10000;
    const chunkMaxChars = Number(chunkMaxCharsRaw) || 2000;

    const chunkBatches = chunkChunksForMicroComputation(chunks, {
      maxBatchItems: chunkBatchSize,
      maxBatchChars: chunkBatchMaxChars,
      maxChunkChars: chunkMaxChars,
    });

    // 4. Run Core
    return await runMicroBatchesForDocument({
      document,
      context: effectiveContext,
      chunkBatches,
      now: new Date().toISOString(),
    });
  },
};
