import { Phase, PipelineContext } from "../../engine/runtime/types";
import { runMicroBatchesForDocument } from "./engine/core/orchestrator";
import {
  runFirstMatchHook,
  splitDocumentIntoChunks,
} from "../../engine/indexing/pluginPipeline";
import { chunkChunksForMicroComputation } from "../../engine/utils/chunkBatching";
import { getProcessedChunkHashes } from "../../engine/databases/indexingState";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "../../engine/momentGraphNamespace";

export const MicroBatchesPhase: Phase<string, any> = {
  name: "micro_batches",
  next: "macro_synthesis",
  execute: async (r2Key: string, context: PipelineContext) => {
    // 1. Prepare Document (Fetch & Namespace)
    // We assume context has the correct r2Key in it? 
    // context extends IndexingHookContext which has r2Key.
    // If execute(input) passes a DIFFERENT r2Key than context.r2Key, we might have issues.
    // But context is created per REQUEST. And Request is for a specific r2Key.
    // So context.r2Key should match input r2Key.
    // We'll use context.r2Key to be safe or update context?
    // IndexingHookContext is an interface. context is an object.
    // We can't easily mutate context if strict.
    // But prepareSourceDocument uses context.r2Key.
    // Let's assume input === context.r2Key.

    const document = await runFirstMatchHook(
      context.plugins,
      "prepareSourceDocument",
      (plugin) => plugin.prepareSourceDocument?.(context)
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

    // Mutate context with namespace? The core uses it.
    // We can cast context to any to set it, or create a child context.
    const effectiveContext = {
        ...context,
        momentGraphNamespace: effectiveNamespace
    };

    // 2. Split & Deduplicate
    const chunks = await splitDocumentIntoChunks(
      document,
      effectiveContext,
      context.plugins
    );

    // Load existing hashes to skip unchanged chunks
    const oldChunkHashes = await getProcessedChunkHashes(r2Key, {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    });
    const oldSet = new Set(oldChunkHashes);
    
    // In Simulation, do we force recollect?
    // Usually we want to test the flow, so maybe yes?
    // But reusing cache is good for speed.
    // Let's assume we skip duplicates unless FORCE_RECOLLECT env var is set?
    const forceRecollect = (context.env as any).FORCE_RECOLLECT === "1";
    
    const newChunks = forceRecollect
      ? chunks
      : chunks.filter((c) => !oldSet.has(c.contentHash ?? ""));

    if (newChunks.length === 0) {
      return { batches: [], microMoments: [] };
    }

    // 3. Batch
    const chunkBatchSizeRaw = (context.env as any)
      .MICRO_MOMENT_CHUNK_BATCH_SIZE;
    const chunkBatchMaxCharsRaw = (context.env as any)
      .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
    const chunkMaxCharsRaw = (context.env as any) // Assuming this is max chunk chars
        .MICRO_MOMENT_CHUNK_MAX_CHARS;

    const chunkBatchSize = Number(chunkBatchSizeRaw) || 10;
    const chunkBatchMaxChars = Number(chunkBatchMaxCharsRaw) || 10000;
    const chunkMaxChars = Number(chunkMaxCharsRaw) || 2000;

    const chunkBatches = chunkChunksForMicroComputation(newChunks, {
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
