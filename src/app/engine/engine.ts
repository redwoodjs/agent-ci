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
import {
  getProcessedChunkHashes,
  setProcessedChunkHashes,
} from "./databases/indexingState";
import { addReplayItemsBatch } from "./databases/indexingState/momentReplay";
import {
  addMoment,
  addDocumentAuditLog,
  findSimilarMoments,
  findAncestors,
  findDescendants,
  findSubjectStartIdForMoment,
  getMoment,
  getRootStatsByHighImportanceSample,
  upsertMicroMomentsBatch,
  getMicroMomentsForDocument,
  findMomentByMicroPathsHash,
  type MicroMoment,
} from "./databases/momentGraph";
import { callLLM } from "./utils/llm";
import { getEmbedding, getEmbeddings } from "./utils/vector";
import { computeMicroBatchesForDocument } from "../pipelines/micro_batches/engine/core/orchestrator";
import { planMicroBatches } from "./lib/phaseCores/micro_batches_core";
import { computeMicroItemsWithoutLlm } from "./utils/microItems";
import { computeMaterializedMomentIdentityTagged, computeMicroPathsHash } from "./lib/phaseCores/materialize_moments_core";
import { computeMacroSynthesisForDocument } from "../pipelines/macro_synthesis/engine/core/orchestrator";
import { computeMicroStreamHash, extractAnchorsFromStreams } from "./lib/phaseCores/macro_synthesis_core";
import { computeDeterministicLinkingProposal } from "./lib/phaseCores/deterministic_linking_core";
import { computeIndexDocumentParentForRootMacroMoment } from "./adapters/live/linking";
import { runPhaseADocumentPreparation } from "./core/indexing/phase_a_orchestrator";
import {
  synthesizeMicroMoments,
  synthesizeMicroMomentsIntoStreams,
  type SynthesisAuditEvent,
} from "./synthesis/synthesizeMicroMoments";
import { extractAnchorTokens } from "./utils/anchorTokens";
import {
  buildParsedDocumentIdentity,
  computeTimeRangeFromMicroMoments,
  mergeMomentSourceMetadata,
} from "./utils/provenance";
import { computeMicroMomentsForChunkBatch } from "./subjects/computeMicroMomentsForChunkBatch";
import { classifyMacroMoments } from "./subjects/classifyMacroMoments";
import { applyMomentGraphNamespacePrefixValue, getMomentGraphNamespacePrefixFromEnv } from "./momentGraphNamespace";
import { getMicroPromptContext, splitDocumentIntoChunks } from "./indexing/pluginPipeline";
import { chunkChunksForMicroComputation } from "./utils/chunkBatching";

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

async function hashStrings(values: string[]): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(values.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uuidFromSha256Hex(hashHex: string): string {
  const hex = (hashHex ?? "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  const padded = (hex + "0".repeat(64)).slice(0, 64);
  const bytes = padded.slice(0, 32);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(
    12,
    16
  )}-${bytes.slice(16, 20)}-${bytes.slice(20, 32)}`;
}

export async function indexDocument(
  r2Key: string,
  context: EngineContext,
  options?: {
    momentGraphNamespace?: string | null;
    momentGraphNamespacePrefix?: string | null;
    momentReplayRunId?: string | null;
    forceRecollect?: boolean | null;
  }
): Promise<Chunk[]> {
  const indexingContext: IndexingHookContext = {
    r2Key,
    env: context.env,
    momentGraphNamespace: null,
    indexingMode:
      typeof options?.momentReplayRunId === "string" &&
      options.momentReplayRunId.trim().length > 0
        ? "replay"
        : "indexing",
  };
  console.log("[moment-linker] indexDocument start", { r2Key });

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

  const forceRecollect = options?.forceRecollect === true;

  const chunkBatchSizeRaw = (indexingContext.env as any)
    .MICRO_MOMENT_CHUNK_BATCH_SIZE;
  const chunkBatchMaxCharsRaw = (indexingContext.env as any)
    .MICRO_MOMENT_CHUNK_BATCH_MAX_CHARS;
  const chunkMaxCharsRaw = (indexingContext.env as any).MICRO_MOMENT_CHUNK_MAX_CHARS;

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

  const momentReplayRunId =
    typeof options?.momentReplayRunId === "string" &&
    options.momentReplayRunId.trim().length > 0
      ? options.momentReplayRunId.trim()
      : null;

  let stage = "start";
  try {
    stage = "phase-a";
    const phaseA = await runPhaseADocumentPreparation({
      ports: {
        prepareSourceDocument: async ({ indexingContext }) => {
          const doc = await runFirstMatchHook(
            context.plugins,
            "prepareSourceDocument",
            (plugin) => plugin.prepareSourceDocument?.(indexingContext)
          );
          if (!doc) {
            throw new Error(`No plugin could prepare document for R2 key: ${r2Key}`);
          }
          return doc;
        },
        computeMomentGraphNamespaceForIndexing: async ({ document, indexingContext, plugins }) => {
          for (const plugin of plugins) {
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
              return ns;
            }
          }
          return null;
        },
        getMomentGraphNamespacePrefixFromEnv,
        applyMomentGraphNamespacePrefixValue: (baseNamespace: string, prefix: string | null) =>
          applyMomentGraphNamespacePrefixValue(baseNamespace, prefix) ?? baseNamespace,
        splitDocumentIntoChunks: async ({ document, indexingContext, plugins }) =>
          await splitDocumentIntoChunks(document, indexingContext, plugins),
        loadProcessedChunkHashes: async ({ r2Key, momentGraphNamespace }) =>
          await getProcessedChunkHashes(r2Key, {
            env: context.env,
            momentGraphNamespace,
          }),
        chunkChunksForMicroComputation: ({ chunks, ...opts }) =>
          chunkChunksForMicroComputation(chunks, opts),
      },
      r2Key,
      env: context.env,
      plugins: context.plugins,
      overrideNamespace,
      overridePrefix,
      indexingMode: momentReplayRunId ? "replay" : "indexing",
      forceRecollect,
      microBatching: {
        maxBatchChars: chunkBatchMaxChars,
        maxChunkChars: chunkMaxChars,
        maxBatchItems: chunkBatchSize,
      },
    });

    const document = phaseA.document;
    const effectiveNamespace = phaseA.effectiveNamespace;
    indexingContext.momentGraphNamespace = effectiveNamespace;

    const momentGraphContext = {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    };

    const chunks = phaseA.chunks;
    const newChunks = phaseA.newChunks;

    if (newChunks.length === 0) {
      console.log("[moment-linker] skipping: no new chunks", { r2Key });
      return [];
    }

    stage = "micro-moments";
    // 3. Compute and cache micro-moments from chunk batches, then synthesize into macro-moments
    // Subjects are now created automatically from root moments via the Moment Graph system.
    // Root moments (moments with no parent) are indexed in SUBJECT_INDEX as Subjects.
    const existingMicroMoments = await getMicroMomentsForDocument(
      document.id,
      momentGraphContext
    );

    const chunkBatches = phaseA.chunkBatches;

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

    const microBatchResults = await computeMicroBatchesForDocument({
      ports: {
        planMicroBatches,
        sha256Hex: async (value: string) => await hashStrings([value]),
        getMicroPromptContext: async (doc, chunks, ctx, plugins) =>
          await getMicroPromptContext(doc, chunks, ctx, plugins),
        loadMicroBatchCache: async ({ batchHash }) => {
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

          if (!hasFullCachedBatch) {
            return null;
          }

          microMomentsForSynthesis.push(...existingBatchItems);
          return {
            microItems: existingBatchItems
              .map((m) => (m.summary ?? "").trim())
              .filter(Boolean),
          };
        },
        storeMicroBatchCache: async ({
          batchHash,
          microItems,
          chunks,
          batchIndex,
        }) => {
          const prefix = `chunk-batch:${batchHash}:`;

          let embeddings: number[][] = [];
          try {
            embeddings = await getEmbeddings(microItems);
          } catch (error) {
            await addDocumentAuditLog(
              document.id,
              "indexing:micro-moment-embedding-error",
              {
                message: error instanceof Error ? error.message : String(error),
                batchHash,
                batchIndex,
              },
              momentGraphContext
            );
            embeddings = [];
          }

          const batchTimeRange = inferBatchTimeRange(
            chunks,
            document.metadata.createdAt
          );
          const batchAuthorRaw = (chunks[0]?.metadata as any)?.author;
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

          for (let i = 0; i < microItems.length; i++) {
            const text = microItems[i] ?? "";
            const embedding = embeddings[i] ?? (await getEmbedding(text));
            const path = `${prefix}${i + 1}`;
            const sourceMetadata = {
              chunkBatchHash: batchHash,
              chunkIds: chunks.map((c) => c.id),
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
              embedding,
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
        },
        computeMicroItemsForChunkBatch: async ({ chunks, promptContext }) => {
          try {
            return (
              (await computeMicroMomentsForChunkBatch(chunks, {
                promptContext,
              })) ?? []
            );
          } catch (error) {
            await addDocumentAuditLog(
              document.id,
              "indexing:micro-moment-batch-error",
              {
                message: error instanceof Error ? error.message : String(error),
                chunkIds: chunks.map((c) => c.id),
              },
              momentGraphContext
            );
            return [];
          }
        },
        fallbackMicroItemsForChunkBatch: ({ chunks }) =>
          computeMicroItemsWithoutLlm(chunks),
        getEmbeddings: async (texts: string[]) => await getEmbeddings(texts),
        getEmbedding: async (text: string) => await getEmbedding(text),
        upsertMicroMomentsBatch: async ({
          documentId,
          momentGraphNamespace,
          microMoments,
        }) => {
          await upsertMicroMomentsBatch(
            documentId,
            microMoments,
            {
              env: context.env,
              momentGraphNamespace,
            }
          );
        },
      },
      document,
      indexingContext,
      plugins: context.plugins,
      chunkBatches,
    });

    const plannedBatches = microBatchResults.map((b) => ({
      batchIndex: b.batchIndex,
      batchHash: b.batchHash,
      promptContext: b.promptContext,
      promptContextHash: b.promptContextHash,
      batchChunks: b.chunks,
    }));

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

      const macroSynthesis = await computeMacroSynthesisForDocument({
        ports: {
          computeMicroStreamHash: async ({ batches }) => {
            return await computeMicroStreamHash({
              batches,
              sha256Hex: async (value) => await hashStrings([value]),
            });
          },
          synthesizeMicroMomentsIntoStreams,
          extractAnchorsFromStreams: ({ streams }) => {
            return extractAnchorsFromStreams({
              streams,
              extractAnchorTokens,
              maxTokensPerMoment: 8,
              maxAnchors: 60,
            });
          },
        },
        plannedBatches: plannedBatches.map((b) => ({
          batchHash: b.batchHash,
          promptContextHash: b.promptContextHash,
        })),
        microMoments: microMomentsForSynthesis.map((m) => ({
          path: m.path,
          summary: m.summary ?? "",
          createdAt: m.createdAt,
        })),
        macroSynthesisPromptContext: macroSynthesisPromptContext ?? null,
        now: new Date().toISOString(),
        documentId: document.id,
      });

      const streams = macroSynthesis.streams;

      for (const event of macroSynthesis.auditEvents as SynthesisAuditEvent[]) {
        await addDocumentAuditLog(
          document.id,
          `synthesis:${event.kind}`,
          {
            ...event,
            documentId: document.id,
            r2Key,
            momentGraphNamespace: momentGraphContext.momentGraphNamespace,
          },
          momentGraphContext
        );
      }

      if (streams.length === 0) {
        await addDocumentAuditLog(
          document.id,
          "indexing:no-macro-streams",
          {
            message: "No macro streams were produced for this document.",
            documentId: document.id,
            r2Key,
          },
          momentGraphContext
        );
      }

      if (streams.length > 0) {
        await addDocumentAuditLog(
          document.id,
          "indexing:macro-synthesis-identity",
          {
            documentId: document.id,
            r2Key,
            streamId: streams[0]?.streamId ?? null,
            microStreamHash: macroSynthesis.microStreamHash,
            anchors: macroSynthesis.anchors,
          },
          momentGraphContext
        );

        console.log("[moment-linker] macro streams synthesized", {
          documentId: document.id,
          streams: streams.map((s) => ({
            streamId: s.streamId,
            macroCount: s.macroMoments.length,
            firstTitle: s.macroMoments[0]?.title ?? null,
          })),
        });

        for (const stream of streams) {
          await addDocumentAuditLog(
            document.id,
            "synthesis:macro-stream-summary",
            {
              streamId: stream.streamId,
              macroCount: stream.macroMoments.length,
              macroTitles: stream.macroMoments
                .slice(0, 20)
                .map((m) => (typeof m?.title === "string" ? m.title : null))
                .filter((t) => typeof t === "string" && t.length > 0),
              macroImportances: stream.macroMoments
                .slice(0, 20)
                .map((m) =>
                  typeof (m as any)?.importance === "number"
                    ? (m as any).importance
                    : null
                ),
            },
            momentGraphContext
          );

          const macroMomentDescriptionsRaw =
            stream.macroMoments as any as MacroMomentDescription[];
          if (macroMomentDescriptionsRaw.length === 0) {
            continue;
          }

          const macroMaxPerStreamRaw = (indexingContext.env as any)
            .MACRO_MOMENT_MAX_PER_STREAM;
          const macroMaxPerStream =
            typeof macroMaxPerStreamRaw === "string"
              ? Number.parseInt(macroMaxPerStreamRaw, 10)
              : typeof macroMaxPerStreamRaw === "number"
              ? macroMaxPerStreamRaw
              : 12;

          const macroMinImportanceRaw = (indexingContext.env as any)
            .MACRO_MOMENT_MIN_IMPORTANCE;
          const macroMinImportance =
            typeof macroMinImportanceRaw === "string"
              ? Number.parseFloat(macroMinImportanceRaw)
              : typeof macroMinImportanceRaw === "number"
              ? macroMinImportanceRaw
              : 0;

          const macroGateResult = (() => {
            const noisePatternsFromEnvRaw = (indexingContext.env as any)
              .MACRO_MOMENT_NOISE_PATTERNS;
            const noisePatternStringsFromEnv =
              typeof noisePatternsFromEnvRaw === "string"
                ? noisePatternsFromEnvRaw
                    .split(/\r?\n|,/g)
                    .map((s: string) => s.trim())
                    .filter((s: string) => s.length > 0)
                : [];

            const discordNoisePatternsFromEnvRaw = (indexingContext.env as any)
              .MACRO_MOMENT_DISCORD_NOISE_PATTERNS;
            const discordNoisePatternStringsFromEnv =
              typeof discordNoisePatternsFromEnvRaw === "string"
                ? discordNoisePatternsFromEnvRaw
                    .split(/\r?\n|,/g)
                    .map((s: string) => s.trim())
                    .filter((s: string) => s.length > 0)
                : [];

            const noisePatternStrings = [
              "\\bdependabot\\b",
              "\\bdeployment preview\\b",
              "\\bpreview deployment\\b",
              "\\bcloudflare pages\\b",
              "\\b(successful deployment|deployed successfully)\\b",
              ...noisePatternStringsFromEnv,
            ];

            const noiseRegexes = noisePatternStrings
              .map((p) => {
                try {
                  return new RegExp(p, "i");
                } catch {
                  return null;
                }
              })
              .filter(Boolean) as RegExp[];

            const discordNoisePatternStrings = [
              "\\bafk\\b",
              "\\bbrb\\b",
              "\\bback\\s+now\\b",
              "\\bapologiz(e|ed|ing)\\b",
              "\\bsync\\b",
              "\\bpair(ing)?\\b",
              "\\btour\\b",
              "\\bmeeting\\b",
              "\\bcall\\b",
              "\\btimezone\\b",
              "\\bschedul(e|ed|ing)\\b",
              ...discordNoisePatternStringsFromEnv,
            ];

            const discordNoiseRegexes = discordNoisePatternStrings
              .map((p) => {
                try {
                  return new RegExp(p, "i");
                } catch {
                  return null;
                }
              })
              .filter(Boolean) as RegExp[];

            function hasTechnicalAnchors(text: string): boolean {
              if (!text) {
                return false;
              }
              if (text.includes("mchn://gh/")) {
                return true;
              }
              if (text.includes("```")) {
                return true;
              }
              if (/\b(error|exception|stack trace|traceback)\b/i.test(text)) {
                return true;
              }
              if (
                /\b(fix|fixed|bug|regression|implement|implemented|add|added|remove|removed|merge|merged)\b/i.test(
                  text
                )
              ) {
                return true;
              }
              return false;
            }

            function isNoiseMacroMoment(m: MacroMomentDescription): boolean {
              const title = typeof m?.title === "string" ? m.title : "";
              const summary =
                typeof (m as any)?.summary === "string"
                  ? ((m as any).summary as string)
                  : "";
              const author = typeof m?.author === "string" ? m.author : "";

              if (
                title.trim() === "Summarized micro-moments" &&
                summary.trim() ===
                  "Synthesized macro-moments could not be parsed."
              ) {
                return true;
              }

              const combinedLower = `${title}\n${summary}`.toLowerCase();
              const isGitHub = combinedLower.includes("mchn://gh/");
              const isDiscord =
                combinedLower.includes("mchn://dc/") ||
                title.trim().toLowerCase().startsWith("[discord");

              if (isDiscord) {
                const combined = `${title}\n${summary}`;
                if (hasTechnicalAnchors(combined)) {
                  return false;
                }
                for (const re of discordNoiseRegexes) {
                  if (re.test(title) || re.test(summary)) {
                    return true;
                  }
                }
                return false;
              }

              if (!isGitHub) {
                return false;
              }

              const authorLower = author.toLowerCase();
              if (
                authorLower.includes("dependabot") ||
                authorLower.includes("[bot]") ||
                authorLower.endsWith("-bot") ||
                authorLower.endsWith(" bot") ||
                authorLower.includes(" bot ")
              ) {
                return true;
              }

              const strippedTitleLower = title
                .replace(/^\s*\[[^\]]+\]\s*/g, "")
                .trim()
                .toLowerCase();

              if (
                strippedTitleLower.startsWith("praise") ||
                strippedTitleLower.startsWith("thanks") ||
                strippedTitleLower.startsWith("thank you") ||
                strippedTitleLower.startsWith("kudos")
              ) {
                return true;
              }

              for (const re of noiseRegexes) {
                if (re.test(title) || re.test(summary)) {
                  return true;
                }
              }

              if (combinedLower.includes("closed issue")) {
                const hasTechnicalSignal =
                  /\b(fix|fixed|bug|error|investigat|regression|implement|implemented|add|added|remove|removed|merge|merged|release|released|ship|shipped|deploy|deployed|rollback)\b/i.test(
                    `${title}\n${summary}`
                  );
                if (!hasTechnicalSignal) {
                  return true;
                }
              }

              return false;
            }

            const withIndex = macroMomentDescriptionsRaw
              .map((m, idx) => ({
                idx,
                m,
                importance:
                  m && typeof (m as any).importance === "number"
                    ? ((m as any).importance as number)
                    : 0,
              }))
              .filter((x) => !isNoiseMacroMoment(x.m));

            if (withIndex.length === 0) {
              return {
                macroMomentDescriptions: [] as MacroMomentDescription[],
                gatingAudit: {
                  inputMacroCount: macroMomentDescriptionsRaw.length,
                  outputMacroCount: 0,
                  noiseDroppedCount: macroMomentDescriptionsRaw.length,
                  noiseDroppedTitlesSample: macroMomentDescriptionsRaw
                    .slice(0, 20)
                    .map((m) => (typeof m?.title === "string" ? m.title : null))
                    .filter((t) => typeof t === "string" && t.length > 0),
                },
              };
            }

            const sortedByImportance = withIndex
              .slice()
              .sort((a, b) => b.importance - a.importance || a.idx - b.idx);

            const max =
              Number.isFinite(macroMaxPerStream) && macroMaxPerStream > 0
                ? Math.floor(macroMaxPerStream)
                : 12;

            const capped = sortedByImportance.slice(0, max);
            const cappedSortedByIndex = capped
              .slice()
              .sort((a, b) => a.idx - b.idx);

            const minImportance =
              Number.isFinite(macroMinImportance) && macroMinImportance >= 0
                ? macroMinImportance
                : 0;

            const filtered = cappedSortedByIndex.filter(
              (x) => x.importance >= minImportance
            );

            if (filtered.length > 0) {
              return {
                macroMomentDescriptions: filtered.map((x) => x.m),
                gatingAudit: {
                  inputMacroCount: macroMomentDescriptionsRaw.length,
                  outputMacroCount: filtered.length,
                  noiseDroppedCount:
                    macroMomentDescriptionsRaw.length - withIndex.length,
                },
              };
            }

            const fallback = cappedSortedByIndex[0] ?? sortedByImportance[0];
            return {
              macroMomentDescriptions: fallback ? [fallback.m] : [],
              gatingAudit: {
                inputMacroCount: macroMomentDescriptionsRaw.length,
                outputMacroCount: fallback ? 1 : 0,
                noiseDroppedCount:
                  macroMomentDescriptionsRaw.length - withIndex.length,
              },
            };
          })();

          const macroMomentDescriptions =
            macroGateResult.macroMomentDescriptions;

          await addDocumentAuditLog(
            document.id,
            "synthesis:macro-gating",
            {
              streamId: stream.streamId,
              inputMacroCount: macroGateResult.gatingAudit.inputMacroCount,
              outputMacroCount: macroGateResult.gatingAudit.outputMacroCount,
              noiseDroppedCount: macroGateResult.gatingAudit.noiseDroppedCount,
              noiseDroppedTitlesSample:
                (macroGateResult.gatingAudit as any).noiseDroppedTitlesSample ??
                null,
              macroMaxPerStream,
              macroMinImportance,
              keptTitles: macroMomentDescriptions
                .slice(0, 20)
                .map((m) => (typeof m?.title === "string" ? m.title : null))
                .filter((t) => typeof t === "string" && t.length > 0),
            },
            momentGraphContext
          );

          if (macroMomentDescriptions.length === 0) {
            continue;
          }

          const classified = await classifyMacroMoments({
            documentId: document.id,
            macroMoments: macroMomentDescriptions,
          });
          if (classified) {
            const byIndex = new Map<number, (typeof classified)[number]>();
            for (const c of classified) {
              byIndex.set(c.index, c);
            }

            for (let i = 0; i < macroMomentDescriptions.length; i++) {
              const c = byIndex.get(i + 1);
              if (!c) {
                continue;
              }
              (macroMomentDescriptions[i] as any).momentKind = c.momentKind;
              (macroMomentDescriptions[i] as any).momentEvidence =
                c.momentEvidence;
              (macroMomentDescriptions[i] as any).isSubject = c.isSubject;
              (macroMomentDescriptions[i] as any).subjectKind = c.subjectKind;
              (macroMomentDescriptions[i] as any).subjectReason =
                c.subjectReason;
              (macroMomentDescriptions[i] as any).subjectEvidence =
                c.subjectEvidence;
              if (c.confidence) {
                (macroMomentDescriptions[i] as any).classificationConfidence =
                  c.confidence;
              }
            }

            await addDocumentAuditLog(
              document.id,
              "synthesis:macro-classification",
              {
                streamId: stream.streamId,
                classifiedCount: classified.length,
                classifications: classified,
              },
              momentGraphContext
            );
          } else {
            await addDocumentAuditLog(
              document.id,
              "synthesis:macro-classification-error",
              {
                streamId: stream.streamId,
                message: "Failed to parse macro classification response.",
                macroCount: macroMomentDescriptions.length,
              },
              momentGraphContext
            );
          }

          stage = "persist-macro-moments";
          let anchorMacroMomentIndex = 0;
          let anchorMacroMomentImportance: number | null = null;
          let anchorMacroMomentForLinking: MacroMomentDescription | null = null;

          const macroImportanceEntries: Array<{
            index: number;
            importance: number;
          }> = [];
          for (let i = 0; i < macroMomentDescriptions.length; i++) {
            const candidate = macroMomentDescriptions[i] as any;
            const importance =
              candidate && typeof candidate.importance === "number"
                ? (candidate.importance as number)
                : null;
            if (importance === null || !Number.isFinite(importance)) {
              continue;
            }
            macroImportanceEntries.push({ index: i, importance });
          }

          if (macroImportanceEntries.length > 0) {
            const sortedImportance = macroImportanceEntries
              .map((e) => e.importance)
              .sort((a, b) => a - b);
            const p75Index =
              sortedImportance.length === 1
                ? 0
                : Math.floor((sortedImportance.length - 1) * 0.75);
            const p75Threshold =
              sortedImportance[p75Index] ?? sortedImportance[0]!;

            const importantChronological = macroImportanceEntries
              .filter((e) => e.importance >= p75Threshold)
              .sort((a, b) => a.index - b.index);

            const minImportantCount =
              macroImportanceEntries.length >= 2 ? 2 : 1;
            const ensuredImportant =
              importantChronological.length >= minImportantCount
                ? importantChronological
                : macroImportanceEntries
                    .slice()
                    .sort(
                      (a, b) => b.importance - a.importance || a.index - b.index
                    )
                    .slice(0, minImportantCount)
                    .sort((a, b) => a.index - b.index);

            const maxImportantCount = 3;
            const limitedImportant = ensuredImportant
              .slice()
              .sort((a, b) => b.importance - a.importance || a.index - b.index)
              .slice(0, maxImportantCount)
              .sort((a, b) => a.index - b.index);

            const firstImportantIndex = limitedImportant[0]?.index ?? 0;
            const firstImportant =
              macroMomentDescriptions[firstImportantIndex] ??
              macroMomentDescriptions[0];

            anchorMacroMomentIndex = firstImportantIndex;
            anchorMacroMomentImportance =
              limitedImportant[0]?.importance ?? null;

            const concatenated = limitedImportant
              .map((entry) => {
                const d = macroMomentDescriptions[entry.index];
                if (!d) {
                  return null;
                }
                const title =
                  typeof d.title === "string" && d.title.trim().length > 0
                    ? d.title.trim()
                    : "";
                const summary =
                  typeof d.summary === "string" && d.summary.trim().length > 0
                    ? d.summary.trim()
                    : "";
                const combined = [title, summary].filter(Boolean).join("\n");
                return combined.length > 0 ? combined : null;
              })
              .filter((v): v is string => typeof v === "string" && v.length > 0)
              .join("\n\n");

            if (firstImportant) {
              anchorMacroMomentForLinking =
                concatenated.length > 0
                  ? {
                      ...firstImportant,
                      summary: concatenated,
                    }
                  : firstImportant;

              await addDocumentAuditLog(
                document.id,
                "synthesis:link-anchor",
                {
                  streamId: stream.streamId,
                  proposalMacroMomentIndex: firstImportantIndex,
                  proposalMacroMomentTitle: firstImportant.title ?? null,
                  proposalMacroMomentImportance: anchorMacroMomentImportance,
                  concatenatedPreview:
                    concatenated.length > 0 ? concatenated.slice(0, 800) : null,
                  concatenatedLength: concatenated.length,
                },
                momentGraphContext
              );
            }
          }

          let resolvedParentIdForFirst: string | undefined = undefined;
          let previousMomentId: string | undefined = undefined;
          let linkAuditLogForFirst: Record<string, any> | null = null;
          const replayItems: Array<{
            itemId: string;
            effectiveNamespace: string;
            documentId?: string | null;
            streamId?: string | null;
            macroMomentIndex?: number | null;
            orderMs: number;
            payload: any;
          }> = [];

          for (let i = 0; i < macroMomentDescriptions.length; i++) {
            const description = macroMomentDescriptions[i];
            if (!description) {
              continue;
            }

            const microPaths = description.microPaths || [];
            const microPathsHashRaw =
              microPaths.length > 0
                ? await computeMicroPathsHash({
                    microPaths,
                    sha256Hex: async (value) => await hashStrings([value]),
                  })
                : null;
            const microPathsHash = microPathsHashRaw ?? undefined;
            const existing =
              microPathsHash !== undefined
                ? await findMomentByMicroPathsHash(
                    document.id,
                    microPathsHash,
                    momentGraphContext
                  )
                : null;

            const deterministicMomentId = (
              await computeMaterializedMomentIdentityTagged({
                tag: "live-materialize-moment",
                identityScope: "live",
                effectiveNamespace: effectiveNamespace ?? null,
                documentId: document.id,
                streamId: stream.streamId,
                macroIndex: i,
                sha256Hex: async (value) => await hashStrings([value]),
                uuidFromSha256Hex,
              })
            ).momentId;

            const momentId =
              existing?.id ?? deterministicMomentId ?? crypto.randomUUID();
            const linkAuditLog =
              i === 0
                ? linkAuditLogForFirst ?? undefined
                : momentReplayRunId
                ? undefined
                : previousMomentId
                ? (() => {
                    const proposal = computeDeterministicLinkingProposal({
                      r2Key,
                      streamId: stream.streamId,
                      macroIndex: i,
                      childMomentId: momentId,
                      prevMomentId: previousMomentId,
                      candidateParentMomentId: null,
                      candidateIssueRef: null,
                      candidateParentR2Key: null,
                    });
                    return {
                      kind: "live.deterministic_linking",
                      ruleId: proposal.ruleId,
                      evidence: proposal.evidence,
                    };
                  })()
                : undefined;
            if (i === 0) {
              if (momentReplayRunId) {
                resolvedParentIdForFirst = undefined;
                linkAuditLogForFirst = { kind: "moment-replay-deferred" };
              } else if (existing?.parentId) {
                resolvedParentIdForFirst = existing.parentId;
                linkAuditLogForFirst = {
                  kind: "reuse-existing-parent",
                  parentId: resolvedParentIdForFirst,
                };
                console.log(
                  "[moment-linker] attachment reuse existing parent",
                  {
                    documentId: document.id,
                    macroMomentIndex: i,
                    parentId: resolvedParentIdForFirst,
                    momentId,
                    streamId: stream.streamId,
                  }
                );
              } else {
                const computed = await computeIndexDocumentParentForRootMacroMoment(
                  {
                    env: context.env,
                    r2Key,
                    documentId: document.id,
                    momentGraphNamespace: effectiveNamespace,
                    momentGraphContext,
                    streamId: stream.streamId,
                    macroIndex: i,
                    childMomentId: momentId,
                    createdAt: description.createdAt,
                    sourceMetadata: description.sourceMetadata as any,
                    title: description.title ?? null,
                    summary: description.summary ?? null,
                  }
                );
                resolvedParentIdForFirst = computed.parentId ?? undefined;
                linkAuditLogForFirst = computed.auditLog;
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
              streamId: stream.streamId,
            });
            const parsedDocumentIdentity = buildParsedDocumentIdentity(document);
            const timeRangeFromMicro = computeTimeRangeFromMicroMoments({
              microMoments: microMomentsForSynthesis,
              microPaths,
            });
            const mergedSourceMetadata = mergeMomentSourceMetadata({
              existing: description.sourceMetadata,
              parsedDocumentIdentity,
              timeRange: timeRangeFromMicro,
            });
            const createdAt =
              typeof description.createdAt === "string" &&
              description.createdAt.trim().length > 0
                ? description.createdAt.trim()
                : timeRangeFromMicro?.start ??
                  (document.metadata?.createdAt ?? new Date().toISOString());
            const author =
              typeof description.author === "string" && description.author.trim().length > 0
                ? description.author.trim()
                : document.metadata?.author ?? "unknown";
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
              momentKind:
                typeof (description as any).momentKind === "string"
                  ? ((description as any).momentKind as any)
                  : undefined,
              momentEvidence: Array.isArray((description as any).momentEvidence)
                ? ((description as any).momentEvidence as any)
                : undefined,
              isSubject: (description as any).isSubject === true,
              subjectKind:
                typeof (description as any).subjectKind === "string"
                  ? ((description as any).subjectKind as any)
                  : undefined,
              subjectReason:
                typeof (description as any).subjectReason === "string"
                  ? ((description as any).subjectReason as string)
                  : undefined,
              subjectEvidence: Array.isArray(
                (description as any).subjectEvidence
              )
                ? ((description as any).subjectEvidence as any)
                : undefined,
              linkAuditLog:
                linkAuditLog,
              createdAt,
              author,
              sourceMetadata: mergedSourceMetadata,
            };

            if (momentReplayRunId) {
              const timeRange = (description.sourceMetadata as any)?.timeRange;
              const startRaw =
                typeof timeRange?.start === "string" ? timeRange.start : null;
              const orderMsFromRange =
                startRaw && Number.isFinite(Date.parse(startRaw))
                  ? Date.parse(startRaw)
                  : null;
              const orderMsFromCreatedAt = Number.isFinite(
                Date.parse(moment.createdAt)
              )
                ? Date.parse(moment.createdAt)
                : null;
              const orderMs =
                orderMsFromRange ?? orderMsFromCreatedAt ?? Date.now();

              const stableItemId = uuidFromSha256Hex(
                await hashStrings([
                  "moment-replay-item",
                  document.id,
                  stream.streamId,
                  String(i),
                ])
              );
              const stablePrevItemId =
                i > 0
                  ? uuidFromSha256Hex(
                      await hashStrings([
                        "moment-replay-item",
                        document.id,
                        stream.streamId,
                        String(i - 1),
                      ])
                    )
                  : null;

              replayItems.push({
                itemId: stableItemId,
                effectiveNamespace: effectiveNamespace ?? "redwood:internal",
                documentId: document.id,
                streamId: stream.streamId,
                macroMomentIndex: i,
                orderMs,
                payload: {
                  effectiveNamespace: effectiveNamespace ?? null,
                  document: {
                    id: document.id,
                    source: document.source,
                    type: document.type,
                    sourceMetadata:
                      (document.metadata as any)?.sourceMetadata ?? null,
                  },
                  streamId: stream.streamId,
                  macroMomentIndex: i,
                  prevItemId: stablePrevItemId,
                  moment: {
                    title: moment.title,
                    summary: moment.summary,
                    author: moment.author,
                    createdAt: moment.createdAt,
                    importance: moment.importance ?? null,
                    momentKind: moment.momentKind ?? null,
                    momentEvidence: moment.momentEvidence ?? null,
                    isSubject: moment.isSubject ?? false,
                    subjectKind: moment.subjectKind ?? null,
                    subjectReason: moment.subjectReason ?? null,
                    subjectEvidence: moment.subjectEvidence ?? null,
                    microPaths: moment.microPaths ?? null,
                    microPathsHash: moment.microPathsHash ?? null,
                    sourceMetadata: moment.sourceMetadata ?? null,
                    linkAuditLog: moment.linkAuditLog ?? null,
                  },
                },
              });
            } else {
              await addMoment(moment, momentGraphContext);
              previousMomentId = momentId;
            }
          }

          if (momentReplayRunId && replayItems.length > 0) {
            await addReplayItemsBatch(
              {
                env: context.env,
                momentGraphNamespace: null,
              },
              {
                runId: momentReplayRunId,
                items: replayItems,
              }
            );
          }
        }
      }
    }

    stage = "enrich-chunks";
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

    stage = "persist-chunk-hashes";
    // 5. After successful processing, update the state with the hashes of *all* current chunks
    const allCurrentChunkHashes = chunks.map((c) => c.contentHash!);
    await setProcessedChunkHashes(r2Key, allCurrentChunkHashes, {
      env: context.env,
      momentGraphNamespace: effectiveNamespace,
    });

    return enrichedChunks;
  } catch (error) {
    await addDocumentAuditLog(
      document.id,
      "indexing:error",
      {
        stage,
        message: error instanceof Error ? error.message : String(error),
        r2Key,
        documentId: document.id,
      },
      momentGraphContext
    );
    throw error;
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

    function readTimeMs(raw: unknown): number | null {
      if (typeof raw !== "string") {
        return null;
      }
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        return null;
      }
      const date = new Date(trimmed);
      const ms = date.getTime();
      return Number.isFinite(ms) ? ms : null;
    }

    function timelineSortKey(moment: {
      createdAt?: string;
      sourceMetadata?: Record<string, any>;
    }): number | null {
      const timeRange = (moment.sourceMetadata as any)?.timeRange as
        | { start?: unknown; end?: unknown }
        | undefined;
      const startMs = readTimeMs(timeRange?.start);
      if (startMs !== null) {
        return startMs;
      }
      return readTimeMs(moment.createdAt);
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
            const candidate = anchorCandidates[0];
            console.log("[query:narrative] anchor candidate", {
              id: candidate.id,
              documentId: candidate.documentId,
            });

            const ancestors = await findAncestors(
              candidate.id,
              momentGraphContext
            );
            const subjectStartId = await findSubjectStartIdForMoment(
              candidate.id,
              momentGraphContext
            );
            const subjectStart =
              subjectStartId && subjectStartId !== candidate.id
                ? await getMoment(subjectStartId, momentGraphContext)
                : subjectStartId === candidate.id
                ? candidate
                : null;
            const root = subjectStart ?? ancestors[0] ?? candidate;
            const chosenMatchId = candidate.id;

            const timeline = await findDescendants(root.id, momentGraphContext);
            console.log(
              `[query:narrative] rootTimelineLen=${timeline.length} (anchoredOn=${root.documentId} matchedOn=${candidate.documentId})`
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

              const requiredIdsList = [root.id, chosenMatchId];
              const cutoffApplied = applyImportanceCutoff({
                timeline,
                requiredIds: requiredIdsList,
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
                  requiredIds: requiredIdsList,
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
                requiredIds: requiredIdsList,
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

              const sortedTimeline = [...prunedTimeline].sort((a, b) => {
                const aKey = timelineSortKey(a);
                const bKey = timelineSortKey(b);
                if (aKey === null && bKey === null) {
                  const aId = (a as any)?.id;
                  const bId = (b as any)?.id;
                  if (typeof aId === "string" && typeof bId === "string") {
                    return aId.localeCompare(bId);
                  }
                  return 0;
                }
                if (aKey === null) {
                  return 1;
                }
                if (bKey === null) {
                  return -1;
                }
                if (aKey !== bKey) {
                  return aKey - bKey;
                }
                const aId = (a as any)?.id;
                const bId = (b as any)?.id;
                if (typeof aId === "string" && typeof bId === "string") {
                  return aId.localeCompare(bId);
                }
                return 0;
              });

              const timelineLines = sortedTimeline.map((moment, idx) =>
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
            const fallbackRoot = ancestors[0];
            const subjectStartId = await findSubjectStartIdForMoment(
              match.id,
              momentGraphContext
            );
            const subjectStart =
              subjectStartId && subjectStartId !== match.id
                ? await getMoment(subjectStartId, momentGraphContext)
                : subjectStartId === match.id
                ? match
                : null;
            const root = subjectStart ?? fallbackRoot;
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

              const sortedTimeline = [...prunedTimeline].sort((a, b) => {
                const aKey = timelineSortKey(a);
                const bKey = timelineSortKey(b);
                if (aKey === null && bKey === null) {
                  const aId = (a as any)?.id;
                  const bId = (b as any)?.id;
                  if (typeof aId === "string" && typeof bId === "string") {
                    return aId.localeCompare(bId);
                  }
                  return 0;
                }
                if (aKey === null) {
                  return 1;
                }
                if (bKey === null) {
                  return -1;
                }
                if (aKey !== bKey) {
                  return aKey - bKey;
                }
                const aId = (a as any)?.id;
                const bId = (b as any)?.id;
                if (typeof aId === "string" && typeof bId === "string") {
                  return aId.localeCompare(bId);
                }
                return 0;
              });

              const timelineLines = sortedTimeline.map((moment, idx) =>
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
