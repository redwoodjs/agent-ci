import type {
  Plugin,
  Document,
  Chunk,
  ChunkMetadata,
  IndexingHookContext,
  QueryHookContext,
  EngineContext,
  ReconstructedContext,
  Moment,
  MacroMomentDescription,
} from "./types";
import { getProcessedChunkHashes, setProcessedChunkHashes } from "./db";
import {
  addMoment,
  findSimilarMoments,
  findAncestors,
  findDescendants,
  getRootStatsByHighImportanceSample,
  upsertMicroMomentsBatch,
  getMicroMomentsForDocument,
  findMomentByMicroPathsHash,
  type MicroMoment,
} from "./momentDb";
import { callLLM } from "./utils/llm";
import { getEmbedding, getEmbeddings } from "./utils/vector";
import { synthesizeMicroMoments } from "./synthesis/synthesizeMicroMoments";
import { computeMicroMomentsForChunkBatch } from "./subjects/computeMicroMomentsForChunkBatch";
import {
  applyMomentGraphNamespacePrefixValue,
  getMomentGraphNamespacePrefixFromEnv,
} from "./momentGraphNamespace";

async function hashChunkId(chunkId: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(chunkId);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex.substring(0, 16);
}

async function hashMicroPaths(microPaths: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(microPaths.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashStrings(values: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(values.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function truncateToChars(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars);
}

function chunkChunksForMicroComputation(
  chunks: Chunk[],
  opts: { maxBatchChars: number; maxChunkChars: number; maxBatchItems: number }
): Chunk[][] {
  const maxBatchChars =
    Number.isFinite(opts.maxBatchChars) && opts.maxBatchChars > 0
      ? opts.maxBatchChars
      : 10_000;
  const maxChunkChars =
    Number.isFinite(opts.maxChunkChars) && opts.maxChunkChars > 0
      ? opts.maxChunkChars
      : 2_000;
  const maxBatchItems =
    Number.isFinite(opts.maxBatchItems) && opts.maxBatchItems > 0
      ? opts.maxBatchItems
      : 10;

  const out: Chunk[][] = [];
  let currentBatch: Chunk[] = [];
  let currentChars = 0;

  function flush() {
    if (currentBatch.length > 0) {
      out.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }
  }

  for (const chunk of chunks) {
    const content = truncateToChars(chunk.content ?? "", maxChunkChars);
    const projectedChars = currentChars + content.length;

    if (
      currentBatch.length > 0 &&
      (currentBatch.length >= maxBatchItems || projectedChars > maxBatchChars)
    ) {
      flush();
    }

    currentBatch.push({
      ...chunk,
      content,
    });
    currentChars += content.length;

    if (currentBatch.length >= maxBatchItems || currentChars > maxBatchChars) {
      flush();
    }
  }

  flush();
  return out;
}

export async function indexDocument(
  r2Key: string,
  context: EngineContext,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
  }
): Promise<Chunk[]> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env: context.env,
    momentGraphNamespace: null,
  };
  console.log("[moment-linker] indexDocument start", { r2Key });

  const document = await runFirstMatchHook(
    context.plugins,
    "prepareSourceDocument",
    (plugin) => plugin.prepareSourceDocument?.(indexingContext)
  );

  if (!document) {
    throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
  }

  const overrideNamespace =
    typeof options?.momentGraphNamespace === "string" &&
    options.momentGraphNamespace.trim().length > 0
      ? options.momentGraphNamespace.trim()
      : null;
  const overridePrefix =
    typeof options?.momentGraphNamespacePrefix === "string" &&
    options.momentGraphNamespacePrefix.trim().length > 0
      ? options.momentGraphNamespacePrefix.trim()
      : null;

  let baseNamespace: string | null = null;
  if (overrideNamespace) {
    baseNamespace = overrideNamespace;
  } else {
    for (const plugin of context.plugins) {
      const nsRaw =
        await plugin.scoping?.computeMomentGraphNamespaceForIndexing?.(
          document,
          indexingContext
        );
      const ns =
        typeof nsRaw === "string" && nsRaw.trim().length > 0
          ? nsRaw.trim()
          : null;
      if (ns) {
        baseNamespace = ns;
        break;
      }
    }
  }

  const envPrefix = getMomentGraphNamespacePrefixFromEnv(indexingContext.env);
  const effectiveNamespace = baseNamespace
    ? overrideNamespace
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, overridePrefix)
      : applyMomentGraphNamespacePrefixValue(
          baseNamespace,
          overridePrefix ?? envPrefix
        )
    : null;

  indexingContext.momentGraphNamespace = effectiveNamespace;

  const momentGraphContext = {
    env: context.env,
    momentGraphNamespace: effectiveNamespace,
  };

  try {
    // 1. Split document into chunks BEFORE subject correlation
    let chunks: Chunk[] | null = null;
    for (const plugin of context.plugins) {
      if (plugin.splitDocumentIntoChunks) {
        const result = await plugin.splitDocumentIntoChunks(
          document,
          indexingContext
        );
        if (result && result.length > 0) {
          chunks = result;
          break;
        }
      }
    }

    if (!chunks || chunks.length === 0) {
      throw new Error(`No plugin could split document into chunks: ${r2Key}`);
    }

    // 2. Diff against previously processed chunks to avoid redundant work
    const oldChunkHashes = await getProcessedChunkHashes(r2Key, {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    });
    const oldChunkHashSet = new Set(oldChunkHashes);

    const newChunks = chunks.filter(
      (chunk) => !oldChunkHashSet.has(chunk.contentHash!)
    );

    if (newChunks.length === 0) {
      console.log("[moment-linker] skipping: no new chunks", { r2Key });
      return []; // Nothing more to do
    }

    // 3. Compute and cache micro-moments from chunk batches, then synthesize into macro-moments
    // Subjects are now created automatically from root moments via the Moment Graph system.
    // Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects.
    const existingMicroMoments = await getMicroMomentsForDocument(
      document.id,
      momentGraphContext
    );

    const chunkBatchSizeRaw = (indexingContext.env as any)
      .MICRO_MOMENT_CHUNK_BATCH_SIZE;
    const chunkBatchMaxCharsRaw = (indexingContext.env as any)
      .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
    const chunkMaxCharsRaw = (indexingContext.env as any)
      .MICRO_MOMENT_CHUNK_MAX_CHARS;

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

    console.log("[moment-linker] micro chunks extracted", {
      documentId: document.id,
      chunks: chunks.length,
      batches: chunkBatches.length,
    });

    const microMomentsForSynthesis: MicroMoment[] = [];

    function parseDateMs(value: unknown): number | null {
      if (typeof value !== "string") {
        return null;
      }
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const ms = Date.parse(trimmed);
      return Number.isFinite(ms) ? ms : null;
    }

    function inferBatchTimeRange(
      chunks: Chunk[],
      documentCreatedAt: string
    ): { start: string; end: string } {
      let minMs: number | null = null;
      let maxMs: number | null = null;

      for (const chunk of chunks) {
        const ts = (chunk.metadata as any)?.timestamp;
        const ms = parseDateMs(ts);
        if (ms === null) {
          continue;
        }
        if (minMs === null || ms < minMs) {
          minMs = ms;
        }
        if (maxMs === null || ms > maxMs) {
          maxMs = ms;
        }
      }

      const fallbackMs = parseDateMs(documentCreatedAt) ?? Date.now();
      const startMs = minMs ?? fallbackMs;
      const endMs = maxMs ?? startMs;

      return {
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
      };
    }

    for (let batchIndex = 0; batchIndex < chunkBatches.length; batchIndex++) {
      const batchChunks = chunkBatches[batchIndex] ?? [];
      const batchKeyParts = batchChunks.map((c) => {
        const hash = c.contentHash ?? "";
        return `${c.id}:${hash}`;
      });
      const batchHash = await hashStrings(batchKeyParts);
      const prefix = `chunk-batch:${batchHash}:`;

      const existingBatchItems = existingMicroMoments
        .filter((m) => m.path.startsWith(prefix))
        .map((m) => {
          const idxStr = m.path.slice(prefix.length);
          const idx = Number.parseInt(idxStr, 10);
          return { idx, m };
        })
        .filter((x) => Number.isFinite(x.idx) && x.idx > 0)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.m);

      const hasFullCachedBatch =
        existingBatchItems.length > 0 &&
        existingBatchItems.every((m) => !!m.summary && !!m.embedding);

      if (hasFullCachedBatch) {
        microMomentsForSynthesis.push(...existingBatchItems);
        continue;
      }

      const microPromptContext = await runFirstMatchHook(
        context.plugins,
        "getMicroMomentBatchPromptContext",
        (plugin) =>
          plugin.subjects?.getMicroMomentBatchPromptContext?.(
            document,
            batchChunks,
            indexingContext
          )
      );

      const promptContext =
        microPromptContext ??
        `Context: These chunks are from a single document.\n` +
          `Focus on concrete details and avoid generic summaries.\n`;

      const computedItems =
        (await computeMicroMomentsForChunkBatch(batchChunks, {
          promptContext,
        })) ?? [];

      const itemsToStore =
        computedItems.length > 0
          ? computedItems
          : batchChunks
              .map((c) => c.content?.trim() ?? "")
              .filter(Boolean)
              .slice(0, 1)
              .map((c) => c.substring(0, 300));

      const embeddings = await getEmbeddings(itemsToStore);
      const batchTimeRange = inferBatchTimeRange(
        batchChunks,
        document.metadata.createdAt
      );
      const batchAuthorRaw = (batchChunks[0]?.metadata as any)?.author;
      const batchAuthor =
        typeof batchAuthorRaw === "string" && batchAuthorRaw.trim().length > 0
          ? batchAuthorRaw.trim()
          : document.metadata.author;

      const microMomentItems: Array<{
        path: string;
        content: string;
        summary: string;
        embedding: number[];
        createdAt?: string;
        author: string;
        sourceMetadata?: Record<string, any>;
      }> = [];

      for (let i = 0; i < itemsToStore.length; i++) {
        const text = itemsToStore[i] ?? "";
        const embedding = embeddings[i] ?? (await getEmbedding(text));
        const path = `${prefix}${i + 1}`;
        const sourceMetadata = {
          chunkBatchHash: batchHash,
          chunkIds: batchChunks.map((c) => c.id),
          timeRange: batchTimeRange,
        };

        microMomentItems.push({
          path,
          content: text,
          summary: text,
          embedding,
          createdAt: batchTimeRange.start,
          author: batchAuthor,
          sourceMetadata,
        });

        microMomentsForSynthesis.push({
          id: crypto.randomUUID(),
          documentId: document.id,
          path,
          content: text,
          summary: text,
          embedding: embedding,
          createdAt: batchTimeRange.start,
          author: batchAuthor,
          sourceMetadata,
        });
      }

      await upsertMicroMomentsBatch(
        document.id,
        microMomentItems,
        momentGraphContext
      );
    }

    if (microMomentsForSynthesis.length > 0) {
      microMomentsForSynthesis.sort((a, b) => {
        const aMs = parseDateMs(a.createdAt) ?? 0;
        const bMs = parseDateMs(b.createdAt) ?? 0;
        if (aMs !== bMs) {
          return aMs - bMs;
        }
        return a.path.localeCompare(b.path);
      });
      console.log("[moment-linker] micro moments loaded", {
        documentId: document.id,
        count: microMomentsForSynthesis.length,
      });

      const macroSynthesisPromptContext = await runFirstMatchHook(
        context.plugins,
        "getMacroSynthesisPromptContext",
        (plugin) =>
          plugin.subjects?.getMacroSynthesisPromptContext?.(
            document,
            indexingContext
          )
      );
      if (macroSynthesisPromptContext) {
        console.log("[moment-linker] macro synthesis prompt context", {
          documentId: document.id,
          context: macroSynthesisPromptContext,
        });
      }

      const macroMomentDescriptions = (await synthesizeMicroMoments(
        microMomentsForSynthesis,
        {
          macroSynthesisPromptContext,
        }
      )) as MacroMomentDescription[];

      if (macroMomentDescriptions.length > 0) {
        console.log("[moment-linker] macro moments synthesized", {
          documentId: document.id,
          count: macroMomentDescriptions.length,
          firstTitle: macroMomentDescriptions[0]?.title,
        });

        let anchorMacroMomentIndex = 0;
        let anchorMacroMomentImportance: number | null = null;
        for (let i = 0; i < macroMomentDescriptions.length; i++) {
          const candidate = macroMomentDescriptions[i] as any;
          const importance =
            candidate && typeof candidate.importance === "number"
              ? (candidate.importance as number)
              : null;
          if (importance === null) {
            continue;
          }
          if (
            anchorMacroMomentImportance === null ||
            importance > anchorMacroMomentImportance
          ) {
            anchorMacroMomentIndex = i;
            anchorMacroMomentImportance = importance;
          }
        }

        let resolvedParentIdForFirst: string | undefined = undefined;
        let previousMomentId: string | undefined = undefined;

        for (let i = 0; i < macroMomentDescriptions.length; i++) {
          const description = macroMomentDescriptions[i];
          if (!description) {
            continue;
          }

          const microPaths = description.microPaths || [];
          const microPathsHash =
            microPaths.length > 0
              ? await hashMicroPaths(microPaths)
              : undefined;
          const existing =
            microPathsHash !== undefined
              ? await findMomentByMicroPathsHash(
                  document.id,
                  microPathsHash,
                  momentGraphContext
                )
              : null;

          const momentId = existing?.id ?? crypto.randomUUID();
          if (i === 0) {
            if (existing?.parentId) {
              resolvedParentIdForFirst = existing.parentId;
              console.log("[moment-linker] attachment reuse existing parent", {
                documentId: document.id,
                macroMomentIndex: i,
                parentId: resolvedParentIdForFirst,
                momentId,
              });
            } else {
              const anchorMacroMoment =
                macroMomentDescriptions[anchorMacroMomentIndex] ??
                macroMomentDescriptions[0];
              const parentProposal = await runFirstMatchHook(
                context.plugins,
                "proposeMacroMomentParent",
                (plugin) =>
                  plugin.subjects?.proposeMacroMomentParent?.(
                    document,
                    anchorMacroMoment,
                    anchorMacroMomentIndex,
                    indexingContext
                  )
              );
              resolvedParentIdForFirst = parentProposal?.parentMomentId;
              if (parentProposal) {
                console.log("[moment-linker] attachment proposal", {
                  documentId: document.id,
                  macroMomentIndex: i,
                  proposalMacroMomentIndex: anchorMacroMomentIndex,
                  proposalMacroMomentImportance: anchorMacroMomentImportance,
                  parentMomentId: parentProposal.parentMomentId,
                  matchedSubjectId: parentProposal.matchedSubjectId,
                  score: parentProposal.score,
                });
              } else {
                console.log("[moment-linker] no attachment proposal", {
                  documentId: document.id,
                  macroMomentIndex: i,
                  proposalMacroMomentIndex: anchorMacroMomentIndex,
                  proposalMacroMomentImportance: anchorMacroMomentImportance,
                });
              }
            }
          }
          console.log("[moment-linker] macro correlation", {
            documentId: document.id,
            index: i,
            title: description.title,
            microPathsCount: microPaths.length,
            microPathsHash,
            reuseExisting: Boolean(existing),
            momentId,
            parentId:
              i === 0
                ? resolvedParentIdForFirst ?? null
                : previousMomentId ?? null,
          });
          const moment: Moment = {
            id: momentId,
            documentId: document.id,
            summary:
              description.summary || description.content.substring(0, 200),
            title: description.title,
            parentId: i === 0 ? resolvedParentIdForFirst : previousMomentId,
            microPaths,
            microPathsHash,
            importance:
              typeof (description as any).importance === "number"
                ? ((description as any).importance as number)
                : undefined,
            createdAt: description.createdAt,
            author: description.author,
            sourceMetadata: description.sourceMetadata,
          };

          await addMoment(moment, momentGraphContext);
          previousMomentId = momentId;
        }
      }
    }

    // 4. Enrich chunks (optional, original logic for the new chunks)
    const enrichedChunks: Chunk[] = [];
    for (const chunk of newChunks) {
      let enrichedChunk = chunk;
      for (const plugin of context.plugins) {
        if (plugin.evidence?.enrichChunk) {
          const result = await plugin.evidence.enrichChunk(
            enrichedChunk,
            indexingContext
          );
          if (result) {
            enrichedChunk = result;
          }
        }
      }
      enrichedChunks.push(enrichedChunk);
    }

    // 5. After successful processing, update the state with the hashes of *all* current chunks
    const allCurrentChunkHashes = chunks.map((c) => c.contentHash!);
    await setProcessedChunkHashes(r2Key, allCurrentChunkHashes, {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    });

    return enrichedChunks;
  } finally {
    // no global namespace mutation
  }
}

export async function query(
  userQuery: string,
  context: EngineContext,
  options?: {
    responseMode?: "answer" | "brief" | "prompt";
    clientContext?: Record<string, any>;
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
  }
): Promise<string> {
  const responseMode = options?.responseMode ?? "answer";

  try {
    const overrideNamespace =
      typeof options?.momentGraphNamespace === "string" &&
      options.momentGraphNamespace.trim().length > 0
        ? options.momentGraphNamespace.trim()
        : null;
    const overridePrefix =
      typeof options?.momentGraphNamespacePrefix === "string" &&
      options.momentGraphNamespacePrefix.trim().length > 0
        ? options.momentGraphNamespacePrefix.trim()
        : null;

    const queryContext: QueryHookContext = {
      query: userQuery,
      env: context.env,
      clientContext: options?.clientContext,
      momentGraphNamespace: null,
    };

    let baseNamespace: string | null = null;
    if (overrideNamespace) {
      baseNamespace = overrideNamespace;
    } else {
      for (const plugin of context.plugins) {
        const nsRaw =
          await plugin.scoping?.computeMomentGraphNamespaceForQuery?.(
            queryContext
          );
        const ns =
          typeof nsRaw === "string" && nsRaw.trim().length > 0
            ? nsRaw.trim()
            : null;
        if (ns) {
          baseNamespace = ns;
          break;
        }
      }
    }

    const envPrefix = getMomentGraphNamespacePrefixFromEnv(context.env);
    const effectiveNamespace = baseNamespace
      ? overrideNamespace
        ? applyMomentGraphNamespacePrefixValue(baseNamespace, overridePrefix)
        : applyMomentGraphNamespacePrefixValue(
            baseNamespace,
            overridePrefix ?? envPrefix
          )
      : null;

    queryContext.momentGraphNamespace = effectiveNamespace;

    const momentGraphContext = {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    };

    function formatIso8601(raw: unknown): string {
      if (typeof raw !== "string") {
        return "";
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return "";
      }
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) {
        return trimmed;
      }
      return date.toISOString();
    }

    function formatTimelineLine(
      moment: {
        createdAt?: string;
        title?: string;
        summary?: string;
        sourceMetadata?: Record<string, any>;
        importance?: number;
      },
      idx: number
    ): string {
      const timeRange = (moment.sourceMetadata as any)?.timeRange as
        | { start?: unknown; end?: unknown }
        | undefined;
      const rangeStart = formatIso8601(timeRange?.start);
      const rangeEnd = formatIso8601(timeRange?.end);
      const iso = formatIso8601(moment.createdAt);
      const prefix =
        rangeStart.length > 0 && rangeEnd.length > 0 && rangeStart !== rangeEnd
          ? `${rangeStart}..${rangeEnd} `
          : iso.length > 0
          ? `${iso} `
          : "";

      const rawImportance = moment.importance;
      const importance =
        typeof rawImportance === "number" && Number.isFinite(rawImportance)
          ? clamp01(rawImportance)
          : null;
      const importanceText =
        importance === null
          ? `importance=not_provided `
          : `importance=${importance.toFixed(2)} `;

      return `${prefix}${importanceText}${idx + 1}. ${moment.title}: ${
        moment.summary
      }`;
    }

    function buildBriefingText(input: {
      momentGraphNamespace: string;
      query: string;
      subject: {
        title?: string;
        summary?: string;
        id?: string;
        documentId?: string;
      };
      timelineLines: string[];
    }): string {
      const lines: string[] = [];
      lines.push(`Instructions`);
      lines.push(
        `- Prefer a single tool call. Do not call the tool again unless the user asks for more context that is not present in this output.`
      );
      lines.push(
        `- Use the Timeline lines as the only source of events. Do not invent events.`
      );
      lines.push(
        `- Select only the timeline events that are needed to answer the user's question. Do not try to mention every event.`
      );
      lines.push(
        `- Timeline lines may include an importance=0..1 field. Prefer higher importance events when selecting which events to mention.`
      );
      lines.push(
        `- When you mention an event, include its timestamp (or timestamp range) as shown on the line.`
      );
      lines.push(
        `- When you mention an event, include the data source label as shown in the line text.`
      );
      lines.push(``);
      lines.push(`Subject`);
      lines.push(
        `${input.subject.title ?? ""}: ${input.subject.summary ?? ""}`.trim()
      );
      lines.push(``);
      lines.push(`Timeline`);
      return `${lines.join("\n")}\n${input.timelineLines.join("\n")}\n`;
    }

    function readEnvNumber(
      name: string,
      fallback: number
    ): { value: number; usedFallback: boolean } {
      const raw = (context.env as any)?.[name];
      if (typeof raw !== "string") {
        return { value: fallback, usedFallback: true };
      }
      const trimmed = raw.trim();
      if (!trimmed) {
        return { value: fallback, usedFallback: true };
      }
      const parsed = Number.parseFloat(trimmed);
      if (!Number.isFinite(parsed)) {
        return { value: fallback, usedFallback: true };
      }
      return { value: parsed, usedFallback: false };
    }

    function clamp01(value: number): number {
      if (value < 0) {
        return 0;
      }
      if (value > 1) {
        return 1;
      }
      return value;
    }

    function momentImportance(value: unknown): number {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return 0;
      }
      return clamp01(value);
    }

    function applyImportanceCutoff<
      T extends { id?: string; importance?: number }
    >(input: {
      timeline: T[];
      requiredIds: string[];
      cutoff: number;
    }): { timeline: T[]; removedCount: number } {
      const required = new Set(
        input.requiredIds.filter(
          (id) => typeof id === "string" && id.trim().length > 0
        )
      );
      const cutoff = clamp01(input.cutoff);

      let removedCount = 0;
      const timeline = input.timeline.filter((m) => {
        const id = typeof m?.id === "string" ? m.id : null;
        if (id && required.has(id)) {
          return true;
        }
        const imp = momentImportance(m?.importance);
        if (imp >= cutoff) {
          return true;
        }
        removedCount += 1;
        return false;
      });

      return { timeline, removedCount };
    }

    function pruneTimeline(input: {
      timeline: Array<{
        id?: string;
        importance?: number;
      }>;
      requiredIds: string[];
      maxMoments: number;
      minImportance: number;
      neighborWindow: number;
      endBiasWeight: number;
    }): number[] {
      const n = input.timeline.length;
      if (n === 0) {
        return [];
      }

      const required = new Set(
        input.requiredIds.filter(
          (id) => typeof id === "string" && id.length > 0
        )
      );

      const safeMax = Math.max(1, Math.floor(input.maxMoments));
      const safeMinImportance = clamp01(input.minImportance);
      const safeNeighborWindow = Math.max(0, Math.floor(input.neighborWindow));
      const safeEndBiasWeight = Math.max(0, input.endBiasWeight);

      function importanceAt(idx: number): number {
        return momentImportance(input.timeline[idx]?.importance);
      }

      function endBiasAt(idx: number): number {
        if (n <= 1) {
          return 1;
        }
        const pos = idx / (n - 1);
        return 2 * Math.abs(0.5 - pos);
      }

      function scoreAt(idx: number): number {
        const imp = importanceAt(idx);
        const endBias = endBiasAt(idx);
        return imp + (1 - imp) * endBias * safeEndBiasWeight;
      }

      const seed = new Set<number>();
      for (let i = 0; i < n; i++) {
        const id = input.timeline[i]?.id;
        if (typeof id === "string" && required.has(id)) {
          seed.add(i);
          continue;
        }
        if (importanceAt(i) >= safeMinImportance) {
          seed.add(i);
        }
      }

      const requiredIndices: number[] = [];
      for (let i = 0; i < n; i++) {
        const id = input.timeline[i]?.id;
        if (typeof id === "string" && required.has(id)) {
          requiredIndices.push(i);
        }
      }

      function capSet(indices: Set<number>): Set<number> {
        if (indices.size <= safeMax) {
          return indices;
        }

        const requiredSet = new Set(requiredIndices);
        const scored = Array.from(indices).map((idx) => ({
          idx,
          score: scoreAt(idx),
        }));

        scored.sort((a, b) => {
          if (a.score !== b.score) {
            return b.score - a.score;
          }
          return a.idx - b.idx;
        });

        const out = new Set<number>();
        for (const idx of requiredSet) {
          out.add(idx);
        }

        for (const item of scored) {
          if (out.size >= safeMax) {
            break;
          }
          out.add(item.idx);
        }

        if (out.size === 0) {
          out.add(0);
        }
        return out;
      }

      const cappedSeed = capSet(seed);

      const expanded = new Set<number>(cappedSeed);
      if (safeNeighborWindow > 0) {
        for (const idx of cappedSeed) {
          const start = Math.max(0, idx - safeNeighborWindow);
          const end = Math.min(n - 1, idx + safeNeighborWindow);
          for (let j = start; j <= end; j++) {
            expanded.add(j);
          }
        }
      }

      const cappedExpanded = capSet(expanded);

      return Array.from(cappedExpanded).sort((a, b) => a - b);
    }

    // Narrative Query Path: Find a moment match, resolve root, then descend
    try {
      const momentGraphNamespace = effectiveNamespace ?? "default";
      console.log(`[query:narrative] namespace=${momentGraphNamespace}`);

      const queryEmbedding = await generateEmbedding(context.env, userQuery);

      const similarMoments = await findSimilarMoments(
        queryEmbedding,
        20,
        momentGraphContext
      );
      console.log(`[query:narrative] similarMoments=${similarMoments.length}`);
      if (similarMoments.length > 0) {
        console.log(
          `[query:narrative] similarMomentSample=${similarMoments
            .slice(0, 5)
            .map((m) => `${m.id}:${m.documentId}`)
            .join(",")}`
        );
        const bestMatch = similarMoments[0];
        if (bestMatch) {
          // If a GitHub issue or PR moment is in the top matches, anchor on it
          // rather than anchoring on an unrelated high-importance root.
          function isGithubWorkItemDocumentId(value: unknown): boolean {
            if (typeof value !== "string") {
              return false;
            }
            return /^github\/redwoodjs\/sdk\/(issues|pull-requests)\/\d+\/latest\.json$/i.test(
              value
            );
          }

          function isDiscordDocumentId(value: unknown): boolean {
            if (typeof value !== "string") {
              return false;
            }
            // Threads: discord/<guild>/<channel>/threads/<thread>/latest.json
            // Channel day: discord/<guild>/<channel>/<YYYY-MM-DD>.jsonl
            return /^discord\/\d+\/\d+\/(threads\/\d+\/latest\.json|\d{4}-\d{2}-\d{2}\.jsonl)$/i.test(
              value
            );
          }

          const workItemCandidates = similarMoments.filter((m) =>
            isGithubWorkItemDocumentId(m.documentId)
          );

          const discordCandidates = similarMoments.filter((m) =>
            isDiscordDocumentId(m.documentId)
          );

          const anchorCandidates =
            workItemCandidates.length > 0
              ? workItemCandidates
              : discordCandidates;

          if (anchorCandidates.length > 0) {
            const candidatesToTry = anchorCandidates.slice(0, 5);
            for (const candidate of candidatesToTry) {
              console.log("[query:narrative] anchor candidate", {
                id: candidate.id,
                documentId: candidate.documentId,
              });

              const root = candidate;
              const chosenMatchId = candidate.id;
              const timeline = await findDescendants(
                root.id,
                momentGraphContext
              );
              console.log(
                `[query:narrative] rootTimelineLen=${timeline.length} (anchoredOn=${candidate.documentId})`
              );

              if (timeline.length > 0) {
                const maxMoments = readEnvNumber(
                  "MOMENT_GRAPH_MAX_TIMELINE_MOMENTS",
                  200
                ).value;
                const queryImportanceCutoff = readEnvNumber(
                  "MOMENT_GRAPH_QUERY_IMPORTANCE_CUTOFF",
                  0.4
                ).value;
                const minImportance = readEnvNumber(
                  "MOMENT_GRAPH_MIN_IMPORTANCE",
                  0.8
                ).value;
                const neighborWindow = readEnvNumber(
                  "MOMENT_GRAPH_TIMELINE_NEIGHBOR_WINDOW",
                  1
                ).value;
                const endBiasWeight = readEnvNumber(
                  "MOMENT_GRAPH_TIMELINE_END_BIAS_WEIGHT",
                  0.4
                ).value;

                const requiredIds = [root.id, chosenMatchId];
                const cutoffApplied = applyImportanceCutoff({
                  timeline,
                  requiredIds,
                  cutoff: queryImportanceCutoff,
                });
                console.log("[query:narrative] applied importance cutoff", {
                  cutoff: clamp01(queryImportanceCutoff),
                  removedCount: cutoffApplied.removedCount,
                  beforeLen: timeline.length,
                  afterLen: cutoffApplied.timeline.length,
                });

                let prunedTimeline = cutoffApplied.timeline;
                if (prunedTimeline.length > maxMoments) {
                  const keptIndices = pruneTimeline({
                    timeline: prunedTimeline,
                    requiredIds,
                    maxMoments,
                    minImportance,
                    neighborWindow,
                    endBiasWeight,
                  });
                  prunedTimeline = keptIndices
                    .map((idx) => prunedTimeline[idx])
                    .filter(Boolean);
                }

                const cutoffAfterPrune = applyImportanceCutoff({
                  timeline: prunedTimeline,
                  requiredIds,
                  cutoff: queryImportanceCutoff,
                });
                if (cutoffAfterPrune.removedCount > 0) {
                  console.log(
                    "[query:narrative] applied importance cutoff post-prune",
                    {
                      cutoff: clamp01(queryImportanceCutoff),
                      removedCount: cutoffAfterPrune.removedCount,
                      beforeLen: prunedTimeline.length,
                      afterLen: cutoffAfterPrune.timeline.length,
                    }
                  );
                }
                prunedTimeline = cutoffAfterPrune.timeline;

                const timelineLines = prunedTimeline.map((moment, idx) =>
                  formatTimelineLine(moment, idx)
                );
                const narrativeContext = timelineLines.join("\n\n");

                const narrativePrompt = `Based on the following Subject and its timeline of events, answer the user's question. The Subject represents the main topic, and the timeline shows the sequence of related moments in chronological order.

## Subject
${root.title}: ${root.summary}

## Timeline
${narrativeContext}

## User Question
${userQuery}

## Instructions
Rules:
- You MUST only use timestamps that appear at the start of Timeline lines. Do not invent or guess dates.
- When you mention an event, you MUST include the exact timestamp (or timestamp range) that appears on that event's Timeline line.
- You MUST include the data source label when you mention an event (example: the bracketed title prefix like "[GitHub Issue #552]" or "[Discord Thread]" that appears in the Timeline text).
- You MUST NOT mention events, sources, or pull requests/issues that are not present in the Timeline text.
- You MUST NOT try to mention every event in the Timeline. Mention only events needed to answer the question.
- If a Timeline line includes an importance=0..1 field, prefer higher importance events when selecting which events to mention.
- If the Timeline does not contain enough information to answer part of the question, say that directly.

Write a clear narrative answer that explains the sequence and causal relationships between events using the Timeline order.`;

                if (responseMode === "prompt") {
                  return narrativePrompt;
                }
                if (responseMode === "brief") {
                  return buildBriefingText({
                    momentGraphNamespace,
                    query: userQuery,
                    subject: root,
                    timelineLines,
                  });
                }
                const narrativeAnswer = await callLLM(
                  narrativePrompt,
                  "slow-reasoning",
                  {
                    temperature: 0,
                    reasoning: { effort: "low" },
                  }
                );
                return narrativeAnswer;
              }
            }
          }

          const minImportance = readEnvNumber(
            "MOMENT_GRAPH_MIN_IMPORTANCE",
            0.8
          ).value;
          const sampleLimit = readEnvNumber(
            "MOMENT_GRAPH_ROOT_SAMPLE_LIMIT",
            2000
          ).value;
          const topRootsLimit = readEnvNumber(
            "MOMENT_GRAPH_ROOT_TOP_LIMIT",
            50
          ).value;
          const topKMatches = readEnvNumber(
            "MOMENT_GRAPH_ROOT_MATCH_TOPK",
            10
          ).value;

          const sampledRootStats = await getRootStatsByHighImportanceSample(
            momentGraphContext,
            {
              highImportanceCutoff: clamp01(minImportance),
              sampleLimit,
              limit: topRootsLimit,
            }
          );
          const rootOrder = new Map<string, number>();
          const rootStats = new Map<
            string,
            {
              sampledHighImportanceCount: number;
              sampledImportanceSum: number;
            }
          >();
          for (let i = 0; i < sampledRootStats.length; i++) {
            const row = sampledRootStats[i];
            rootOrder.set(row.rootId, i);
            rootStats.set(row.rootId, {
              sampledHighImportanceCount: row.sampledHighImportanceCount,
              sampledImportanceSum: row.sampledImportanceSum,
            });
          }

          const candidateRoots = new Map<
            string,
            { root: Moment; matchId: string; matchRank: number }
          >();
          const matchesToConsider = similarMoments.slice(
            0,
            Math.max(1, topKMatches)
          );
          for (let i = 0; i < matchesToConsider.length; i++) {
            const match = matchesToConsider[i];
            const ancestors = await findAncestors(match.id, momentGraphContext);
            const root = ancestors[0];
            if (!root) {
              continue;
            }
            if (!candidateRoots.has(root.id)) {
              candidateRoots.set(root.id, {
                root,
                matchId: match.id,
                matchRank: i,
              });
            }
          }

          let chosenRootId: string | null = null;
          let chosenMatchId: string = bestMatch.id;
          let chosenMatchRank = 0;

          const fallbackAncestors = await findAncestors(
            bestMatch.id,
            momentGraphContext
          );
          const fallbackRoot = fallbackAncestors[0];
          if (fallbackRoot) {
            chosenRootId = fallbackRoot.id;
          }

          for (const [rootId, candidate] of candidateRoots.entries()) {
            const stats = rootStats.get(rootId);
            if (!stats) {
              continue;
            }
            if (chosenRootId === null) {
              chosenRootId = rootId;
              chosenMatchId = candidate.matchId;
              chosenMatchRank = candidate.matchRank;
              continue;
            }
            const chosenStats = rootStats.get(chosenRootId);
            if (!chosenStats) {
              chosenRootId = rootId;
              chosenMatchId = candidate.matchId;
              chosenMatchRank = candidate.matchRank;
              continue;
            }
            if (
              stats.sampledHighImportanceCount >
              chosenStats.sampledHighImportanceCount
            ) {
              chosenRootId = rootId;
              chosenMatchId = candidate.matchId;
              chosenMatchRank = candidate.matchRank;
              continue;
            }
            if (
              stats.sampledHighImportanceCount ===
                chosenStats.sampledHighImportanceCount &&
              stats.sampledImportanceSum > chosenStats.sampledImportanceSum
            ) {
              chosenRootId = rootId;
              chosenMatchId = candidate.matchId;
              chosenMatchRank = candidate.matchRank;
              continue;
            }
            if (
              stats.sampledHighImportanceCount ===
                chosenStats.sampledHighImportanceCount &&
              stats.sampledImportanceSum === chosenStats.sampledImportanceSum
            ) {
              const currentOrder =
                rootOrder.get(rootId) ?? Number.POSITIVE_INFINITY;
              const chosenOrder =
                rootOrder.get(chosenRootId) ?? Number.POSITIVE_INFINITY;
              if (currentOrder < chosenOrder) {
                chosenRootId = rootId;
                chosenMatchId = candidate.matchId;
                chosenMatchRank = candidate.matchRank;
                continue;
              }
              if (currentOrder === chosenOrder) {
                if (candidate.matchRank < chosenMatchRank) {
                  chosenRootId = rootId;
                  chosenMatchId = candidate.matchId;
                  chosenMatchRank = candidate.matchRank;
                  continue;
                }
              }
            }
          }

          const root =
            chosenRootId !== null
              ? candidateRoots.get(chosenRootId)?.root ?? fallbackRoot ?? null
              : null;
          if (root) {
            console.log(
              `[query:narrative] resolvedRootFromMatch root=${root.id} match=${chosenMatchId}`
            );
            const timeline = await findDescendants(root.id, momentGraphContext);
            console.log(`[query:narrative] rootTimelineLen=${timeline.length}`);

            if (timeline.length > 0) {
              const maxMoments = readEnvNumber(
                "MOMENT_GRAPH_MAX_TIMELINE_MOMENTS",
                200
              ).value;
              const queryImportanceCutoff = readEnvNumber(
                "MOMENT_GRAPH_QUERY_IMPORTANCE_CUTOFF",
                0.4
              ).value;
              const neighborWindow = readEnvNumber(
                "MOMENT_GRAPH_TIMELINE_NEIGHBOR_WINDOW",
                1
              ).value;
              const endBiasWeight = readEnvNumber(
                "MOMENT_GRAPH_TIMELINE_END_BIAS_WEIGHT",
                0.4
              ).value;

              const requiredIds = [root.id, chosenMatchId];
              const cutoffApplied = applyImportanceCutoff({
                timeline,
                requiredIds,
                cutoff: queryImportanceCutoff,
              });
              console.log("[query:narrative] applied importance cutoff", {
                cutoff: clamp01(queryImportanceCutoff),
                removedCount: cutoffApplied.removedCount,
                beforeLen: timeline.length,
                afterLen: cutoffApplied.timeline.length,
              });

              let prunedTimeline = cutoffApplied.timeline;
              if (prunedTimeline.length > maxMoments) {
                const keptIndices = pruneTimeline({
                  timeline: prunedTimeline,
                  requiredIds,
                  maxMoments,
                  minImportance,
                  neighborWindow,
                  endBiasWeight,
                });
                prunedTimeline = keptIndices
                  .map((idx) => prunedTimeline[idx])
                  .filter(Boolean);
              }

              const cutoffAfterPrune = applyImportanceCutoff({
                timeline: prunedTimeline,
                requiredIds,
                cutoff: queryImportanceCutoff,
              });
              if (cutoffAfterPrune.removedCount > 0) {
                console.log(
                  "[query:narrative] applied importance cutoff post-prune",
                  {
                    cutoff: clamp01(queryImportanceCutoff),
                    removedCount: cutoffAfterPrune.removedCount,
                    beforeLen: prunedTimeline.length,
                    afterLen: cutoffAfterPrune.timeline.length,
                  }
                );
              }
              prunedTimeline = cutoffAfterPrune.timeline;

              const timelineLines = prunedTimeline.map((moment, idx) =>
                formatTimelineLine(moment, idx)
              );
              const narrativeContext = timelineLines.join("\n\n");

              const narrativePrompt = `Based on the following Subject and its timeline of events, answer the user's question. The Subject represents the main topic, and the timeline shows the sequence of related moments in chronological order.

## Subject
${root.title}: ${root.summary}

## Timeline
${narrativeContext}

## User Question
${userQuery}

## Instructions
Rules:
- You MUST only use timestamps that appear at the start of Timeline lines. Do not invent or guess dates.
- When you mention an event, you MUST include the exact timestamp (or timestamp range) that appears on that event's Timeline line.
- You MUST include the data source label when you mention an event (example: the bracketed title prefix like "[GitHub Issue #552]" or "[Discord Thread]" that appears in the Timeline text).
- You MUST NOT mention events, sources, or pull requests/issues that are not present in the Timeline text.
- You MUST NOT try to mention every event in the Timeline. Mention only events needed to answer the question.
- If a Timeline line includes an importance=0..1 field, prefer higher importance events when selecting which events to mention.
- If the Timeline does not contain enough information to answer part of the question, say that directly.

Write a clear narrative answer that explains the sequence and causal relationships between events using the Timeline order.`;

              if (responseMode === "prompt") {
                return narrativePrompt;
              }
              if (responseMode === "brief") {
                return buildBriefingText({
                  momentGraphNamespace,
                  query: userQuery,
                  subject: root,
                  timelineLines,
                });
              }
              const narrativeAnswer = await callLLM(
                narrativePrompt,
                "slow-reasoning",
                {
                  temperature: 0,
                  reasoning: { effort: "low" },
                }
              );
              return narrativeAnswer;
            }
          }
        }
      }
    } catch (error) {
      console.error(
        `[query:narrative] ✗ Narrative query path failed, falling back to chunk-based RAG:`,
        error
      );
      // Fall through to the existing chunk-based RAG system
    }

    console.log(`[query] no narrative match; evidenceLockerDisabled=true`);
    return `No Moment Graph subject timeline matched this query. Evidence Locker is disabled.`;
  } finally {
    // no global namespace mutation
  }
}

export async function queryEvidenceLocker(
  userQuery: string,
  context: EngineContext
): Promise<string> {
  const queryContext: QueryHookContext = {
    query: userQuery,
    env: context.env,
  };

  const processedQuery = await runWaterfallHook(
    context.plugins,
    "prepareSearchQuery",
    userQuery,
    (query, plugin) =>
      plugin.evidence?.prepareSearchQuery?.(query, queryContext)
  );

  const filterClauses = await runCollectorHook(
    context.plugins,
    "buildVectorSearchFilter",
    (plugin) => plugin.evidence?.buildVectorSearchFilter?.(queryContext)
  );

  const searchResults = await performVectorSearch(
    context.env,
    processedQuery,
    filterClauses
  );

  const rerankedResults = await runWaterfallHook(
    context.plugins,
    "rerankSearchResults",
    searchResults,
    (results, plugin) =>
      plugin.evidence?.rerankSearchResults?.(results, queryContext)
  );

  const reconstructedContexts = await reconstructContexts(
    rerankedResults,
    context.plugins,
    queryContext
  );

  const optimizedContexts = await runWaterfallHook(
    context.plugins,
    "optimizeContext",
    reconstructedContexts,
    (contexts, plugin) =>
      plugin.evidence?.optimizeContext?.(contexts, processedQuery, queryContext)
  );

  const prompt = await runFirstMatchHook(
    [...context.plugins].reverse(),
    "composeLlmPrompt",
    (plugin) =>
      plugin.evidence?.composeLlmPrompt?.(
        optimizedContexts,
        processedQuery,
        queryContext
      )
  );

  if (!prompt) {
    throw new Error("No plugin could compose LLM prompt");
  }

  const llmResponse = await callLLM(prompt);

  const formattedResponse = await runWaterfallHook(
    context.plugins,
    "formatFinalResponse",
    llmResponse,
    (response, plugin) =>
      plugin.evidence?.formatFinalResponse?.(
        response,
        rerankedResults,
        queryContext
      )
  );

  return formattedResponse;
}

async function reconstructContexts(
  chunks: ChunkMetadata[],
  plugins: Plugin[],
  queryContext: QueryHookContext
): Promise<ReconstructedContext[]> {
  const chunksByDocument = new Map<string, ChunkMetadata[]>();

  for (const chunk of chunks) {
    if (!chunk.documentId) {
      continue;
    }
    if (!chunksByDocument.has(chunk.documentId)) {
      chunksByDocument.set(chunk.documentId, []);
    }
    chunksByDocument.get(chunk.documentId)!.push(chunk);
  }

  const bucket = queryContext.env.MACHINEN_BUCKET;

  const documentEntries = Array.from(chunksByDocument.entries());
  const CONCURRENT_FETCH_LIMIT = 6;
  const fetchResults: Array<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
  }> = [];

  async function fetchAndReadDocument(
    documentId: string,
    documentChunks: ChunkMetadata[]
  ): Promise<{
    documentId: string;
    documentChunks: ChunkMetadata[];
    sourceDocument: any;
  }> {
    const object = await bucket.get(documentId);

    if (!object) {
      return { documentId, documentChunks, sourceDocument: null };
    }

    const jsonText = await object.text();
    let sourceDocument: any;
    try {
      sourceDocument = JSON.parse(jsonText);
    } catch (error) {
      sourceDocument = jsonText;
    }

    return { documentId, documentChunks, sourceDocument };
  }

  const inFlight = new Set<Promise<(typeof fetchResults)[0]>>();
  let nextIndex = 0;

  while (nextIndex < documentEntries.length || inFlight.size > 0) {
    while (
      inFlight.size < CONCURRENT_FETCH_LIMIT &&
      nextIndex < documentEntries.length
    ) {
      const [documentId, documentChunks] = documentEntries[nextIndex++];
      const promise = fetchAndReadDocument(documentId, documentChunks);
      promise.finally(() => {
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }

    if (inFlight.size > 0) {
      const result = await Promise.race(Array.from(inFlight));
      fetchResults.push(result);
    }
  }

  const reconstructedContexts: ReconstructedContext[] = [];

  for (const { documentId, documentChunks, sourceDocument } of fetchResults) {
    if (!sourceDocument) {
      continue;
    }

    const reconstructed = await runFirstMatchHook(
      plugins,
      "reconstructContext",
      (plugin) =>
        plugin.evidence?.reconstructContext?.(
          documentChunks,
          sourceDocument,
          queryContext
        )
    );

    if (reconstructed) {
      reconstructedContexts.push(reconstructed);
    }
  }

  return reconstructedContexts;
}

async function runFirstMatchHook<T>(
  plugins: Plugin[],
  hookName: string,
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T | null> {
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      return result;
    }
  }
  return null;
}

async function runWaterfallHook<T>(
  plugins: Plugin[],
  hookName: string,
  initialValue: T,
  fn: (value: T, plugin: Plugin) => Promise<T | undefined> | undefined
): Promise<T> {
  let value = initialValue;
  for (const plugin of plugins) {
    const result = await fn(value, plugin);
    if (result !== undefined) {
      value = result;
    }
  }
  return value;
}

async function runCollectorHook<T>(
  plugins: Plugin[],
  hookName: string,
  fn: (plugin: Plugin) => Promise<T | null | undefined> | undefined
): Promise<T[]> {
  const results: T[] = [];
  for (const plugin of plugins) {
    const result = await fn(plugin);
    if (result !== null && result !== undefined) {
      results.push(result);
    }
  }
  return results;
}

async function performVectorSearch(
  env: Cloudflare.Env,
  query: string,
  filterClauses: Record<string, unknown>[]
): Promise<ChunkMetadata[]> {
  const embedding = await generateEmbedding(env, query);

  const combinedFilter = combineFilterClauses(
    filterClauses as Record<string, unknown>[]
  );

  const vectorizeResponse = await env.VECTORIZE_INDEX.query(embedding, {
    topK: 50,
    returnMetadata: true,
    filter: combinedFilter as any,
  });

  const results = vectorizeResponse.matches.map((match) => {
    if (!match.metadata) {
      throw new Error("Vectorize match missing metadata");
    }
    const metadata = match.metadata as ChunkMetadata;
    (metadata as any).score = match.score;
    return metadata;
  });
  return results;
}

function combineFilterClauses(
  clauses: Record<string, unknown>[]
): Record<string, unknown> | undefined {
  if (clauses.length === 0) {
    return undefined;
  }

  if (clauses.length === 1) {
    return clauses[0];
  }

  return {
    $and: clauses,
  };
}

async function generateEmbedding(
  env: Cloudflare.Env,
  text: string
): Promise<number[]> {
  const response = (await env.AI.run("@cf/baai/bge-base-en-v1.5", {
    text: [text],
  })) as { data: number[][] };

  if (
    !response ||
    !Array.isArray(response.data) ||
    response.data.length === 0
  ) {
    throw new Error("Failed to generate embedding");
  }

  return response.data[0];
}
