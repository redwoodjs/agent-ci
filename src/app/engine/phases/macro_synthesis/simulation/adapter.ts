import type {
  SimulationDbContext,
  SimulationMicroBatchCacheRow,
} from "../../../adapters/simulation/types";
import { getSimulationDb } from "../../../adapters/simulation/db";
import type { MicroMoment } from "../../../databases/momentGraph";
import { getIndexingPlugins } from "../../../indexing/indexingPlugins";
import { prepareDocumentForR2Key } from "../../../indexing/pluginPipeline";
import {
  computeMicroStreamHash,
  extractAnchorsFromStreams,
} from "../../../lib/phaseCores/macro_synthesis_core";
import { sha256Hex } from "../../../utils/crypto";
import { extractAnchorTokens } from "../../../utils/anchorTokens";
import { applyMomentGraphNamespacePrefixValue } from "../../../momentGraphNamespace";
import { getMicroMomentsForDocument } from "../../../databases/momentGraph";
import { runMacroSynthesisForR2Key } from "../core/orchestrator";

export async function runMacroSynthesisAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
    ports: {
      synthesizeMicroMomentsIntoStreams: (
        microMoments: MicroMoment[],
        options?: any
      ) => Promise<Array<{ streamId: string; macroMoments: any[] }>>;
    };
  }
): Promise<{
  docsProcessed: number;
  docsReused: number;
  docsSkippedUnchanged: number;
  streamsProduced: number;
  macroMomentsProduced: number;
  failed: number;
  failures: Array<{ r2Key: string; error: string }>;
}> {
  const db = getSimulationDb(context);
  const env = context.env;
  const plugins = getIndexingPlugins(env);

  let docsProcessed = 0;
  let docsReused = 0;
  let docsSkippedUnchanged = 0;
  let failed = 0;
  let streamsProduced = 0;
  let macroMomentsProduced = 0;

  const failures: Array<{ r2Key: string; error: string }> = [];

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["moment_graph_namespace", "moment_graph_namespace_prefix"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as any;
  const baseNamespace =
    typeof runRow?.moment_graph_namespace === "string"
      ? (runRow.moment_graph_namespace as string)
      : null;
  const prefix =
    typeof runRow?.moment_graph_namespace_prefix === "string"
      ? (runRow.moment_graph_namespace_prefix as string)
      : null;
  const effectiveNamespace =
    baseNamespace && prefix
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix)
      : baseNamespace;

  for (const r2Key of input.r2Keys) {
    try {
      const res = await runMacroSynthesisForR2Key({
        ports: {
          loadDocState: async ({ runId, r2Key }) => {
            const docState = (await db
              .selectFrom("simulation_run_documents")
              .select(["changed", "error_json"])
              .where("run_id", "=", runId)
              .where("r2_key", "=", r2Key)
              .executeTakeFirst()) as unknown as
              | { changed: number; error_json: any }
              | undefined;
            return {
              hadError: Boolean((docState as any)?.error_json),
              changed: Number((docState as any)?.changed ?? 1) !== 0,
            };
          },
          loadMicroBatches: async ({ runId, r2Key }) => {
            const batches = (await db
              .selectFrom("simulation_run_micro_batches")
              .select(["batch_index", "batch_hash", "prompt_context_hash"])
              .where("run_id", "=", runId)
              .where("r2_key", "=", r2Key)
              .orderBy("batch_index", "asc")
              .execute()) as unknown as Array<{
              batch_index: number;
              batch_hash: string;
              prompt_context_hash: string;
            }>;
            return batches.map((b) => ({
              batchHash: b.batch_hash,
              promptContextHash: b.prompt_context_hash,
            }));
          },
          loadPreviousMicroStreamHash: async ({ runId, r2Key }) => {
            const existing = (await db
              .selectFrom("simulation_run_macro_outputs")
              .select(["micro_stream_hash"])
              .where("run_id", "=", runId)
              .where("r2_key", "=", r2Key)
              .executeTakeFirst()) as unknown as
              | { micro_stream_hash: string }
              | undefined;
            return typeof (existing as any)?.micro_stream_hash === "string"
              ? ((existing as any).micro_stream_hash as string)
              : null;
          },
          loadMicroMomentsForDocument: async ({ documentId, effectiveNamespace }) => {
            if (!effectiveNamespace) {
              return [];
            }
            const existingMicroMoments = await getMicroMomentsForDocument(
              documentId,
              {
                env,
                momentGraphNamespace: effectiveNamespace,
              }
            );
            return (existingMicroMoments ?? []).map((m: any) => ({
              path: String(m?.path ?? ""),
              summary: String(m?.summary ?? ""),
              createdAt: String(m?.createdAt ?? input.now),
            }));
          },
          loadMicroBatchCacheItems: async ({ batchHash, promptContextHash }) => {
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
            return items.filter((x) => typeof x === "string") as string[];
          },
          getMacroSynthesisInputs: async ({ r2Key }) => {
            const { document, indexingContext } = await prepareDocumentForR2Key(
              r2Key,
              env,
              plugins
            );

            const macroPromptContext = await (async () => {
              for (const plugin of plugins) {
                const v = await plugin.subjects?.getMacroSynthesisPromptContext?.(
                  document,
                  indexingContext
                );
                if (v !== null && v !== undefined) {
                  return v;
                }
              }
              return null;
            })();

            const defaultCreatedAt =
              typeof (document as any)?.metadata?.createdAt === "string" &&
              (document as any).metadata.createdAt.trim().length > 0
                ? ((document as any).metadata.createdAt as string).trim()
                : input.now;

            const defaultAuthor =
              typeof (document as any)?.metadata?.author === "string" &&
              (document as any).metadata.author.trim().length > 0
                ? ((document as any).metadata.author as string).trim()
                : "unknown";

            return {
              documentId: document.id,
              defaultAuthor,
              defaultCreatedAt,
              macroSynthesisPromptContext: macroPromptContext ?? null,
            };
          },
          persistMacroOutputs: async ({
            runId,
            r2Key,
            microStreamHash,
            streams,
            auditEvents,
            gating,
            anchors,
            now,
          }) => {
            await db
              .insertInto("simulation_run_macro_outputs")
              .values({
                run_id: runId,
                r2_key: r2Key,
                micro_stream_hash: microStreamHash,
                use_llm: 1 as any,
                streams_json: JSON.stringify(streams),
                audit_json:
                  auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
                gating_json: JSON.stringify(gating),
                anchors_json: JSON.stringify(anchors),
                created_at: now,
                updated_at: now,
              } as any)
              .onConflict((oc) =>
                oc.columns(["run_id", "r2_key"]).doUpdateSet({
                  micro_stream_hash: microStreamHash,
                  use_llm: 1 as any,
                  streams_json: JSON.stringify(streams),
                  audit_json:
                    auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
                  gating_json: JSON.stringify(gating),
                  anchors_json: JSON.stringify(anchors),
                  updated_at: now,
                } as any)
              )
              .execute();
          },
          computeMicroStreamHash: async ({ batches }) => {
            return await computeMicroStreamHash({
              batches,
              sha256Hex,
            });
          },
          synthesizeMicroMomentsIntoStreams:
            input.ports.synthesizeMicroMomentsIntoStreams,
          extractAnchorsFromStreams: ({ streams }) => {
            return extractAnchorsFromStreams({
              streams,
              extractAnchorTokens,
              maxTokensPerMoment: 25,
              maxAnchors: 200,
            });
          },
        },
        runId: input.runId,
        r2Key,
        effectiveNamespace,
        now: input.now,
      });

      if (res.kind === "skipped_unchanged") {
        docsSkippedUnchanged++;
        continue;
      }
      if (res.kind === "skipped_error") {
        failed++;
        failures.push({ r2Key, error: "ingest_diff error" });
        continue;
      }
      if (res.kind === "reused") {
        docsReused++;
        continue;
      }

      docsProcessed++;
      streamsProduced += res.streamsProduced;
      macroMomentsProduced += res.macroMomentsProduced;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await input.log.error("item.error", {
        phase: "macro_synthesis",
        r2Key,
        error: msg,
      });
    }
  }

  return {
    docsProcessed,
    docsReused,
    docsSkippedUnchanged,
    streamsProduced,
    macroMomentsProduced,
    failed,
    failures,
  };
}

