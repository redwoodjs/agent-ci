import type {
  SimulationDbContext,
  SimulationMicroBatchCacheRow,
} from "../types";
import { getSimulationDb } from "../db";
import { getIndexingPlugins } from "../../../indexing/indexingPlugins";
import { prepareDocumentForR2Key } from "../../../indexing/pluginPipeline";
import { synthesizeMicroMomentsIntoStreams } from "../../../synthesis/synthesizeMicroMoments";
import {
  computeMicroStreamHash,
  extractAnchorsFromStreams,
} from "../../../lib/phaseCores/macro_synthesis_core";
import { sha256Hex } from "../../../utils/crypto";
import { extractAnchorTokens } from "../../../utils/anchorTokens";
import { computeMacroSynthesisForDocument } from "../../../core/indexing/macro_synthesis_orchestrator";
import { applyMomentGraphNamespacePrefixValue } from "../../../momentGraphNamespace";
import { getMicroMomentsForDocument } from "../../../databases/momentGraph";

export async function runMacroSynthesisAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    now: string;
    log: { error: (kind: string, payload: any) => Promise<void> };
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

    try {
      const batches = (await db
        .selectFrom("simulation_run_micro_batches")
        .select(["batch_index", "batch_hash", "prompt_context_hash"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .orderBy("batch_index", "asc")
        .execute()) as unknown as Array<{
        batch_index: number;
        batch_hash: string;
        prompt_context_hash: string;
      }>;

      const microStreamHash = await computeMicroStreamHash({
        batches: batches.map((b) => ({
          batchHash: b.batch_hash,
          promptContextHash: b.prompt_context_hash,
        })),
        sha256Hex,
      });

      const existing = (await db
        .selectFrom("simulation_run_macro_outputs")
        .select(["micro_stream_hash"])
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", r2Key)
        .executeTakeFirst()) as unknown as
        | { micro_stream_hash: string }
        | undefined;

      const prevHash =
        typeof (existing as any)?.micro_stream_hash === "string"
          ? (existing as any).micro_stream_hash
          : null;

      if (prevHash && prevHash === microStreamHash) {
        docsReused++;
        continue;
      }

      docsProcessed++;

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

      const microItems: Array<{
        path: string;
        summary: string;
        createdAt: string;
      }> = [];

      // Prefer reading micro moments from the moment graph (so microPaths are resolvable and
      // createdAt/timeRange are consistent). Fall back to the simulation cache if missing.
      const existingMicroMoments = effectiveNamespace
        ? await getMicroMomentsForDocument(r2Key, {
            env,
            momentGraphNamespace: effectiveNamespace,
          })
        : [];

      for (const b of batches) {
        const prefixPath = `chunk-batch:${b.batch_hash}:`;
        const fromMomentGraph = existingMicroMoments
          .filter(
            (m: any) =>
              typeof m?.path === "string" && m.path.startsWith(prefixPath)
          )
          .map((m: any) => ({
            path: String(m.path),
            summary: String(m.summary ?? "").trim(),
            createdAt: String(m.createdAt ?? input.now),
          }))
          .filter((m) => m.summary.length > 0);

        if (fromMomentGraph.length > 0) {
          microItems.push(...fromMomentGraph);
          continue;
        }

        const cached = (await db
          .selectFrom("simulation_micro_batch_cache")
          .select(["micro_items_json"])
          .where("batch_hash", "=", b.batch_hash)
          .where("prompt_context_hash", "=", b.prompt_context_hash)
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

        for (let j = 0; j < asStrings.length; j++) {
          microItems.push({
            path: `${prefixPath}${j + 1}`,
            summary: asStrings[j],
            createdAt: input.now,
          });
        }
      }

      const synthesis = await computeMacroSynthesisForDocument({
        ports: {
          computeMicroStreamHash: async ({ batches }) => {
            return await computeMicroStreamHash({
              batches,
              sha256Hex,
            });
          },
          synthesizeMicroMomentsIntoStreams: async (microMoments, options) => {
            const asFull = (microMoments ?? []).map((m) => ({
              id: crypto.randomUUID(),
              documentId: r2Key,
              path: m.path,
              content: m.summary,
              summary: m.summary,
              embedding: [],
              createdAt: m.createdAt,
              author: defaultAuthor,
            }));
            return await synthesizeMicroMomentsIntoStreams(
              asFull as any,
              options as any
            );
          },
          extractAnchorsFromStreams: ({ streams }) => {
            return extractAnchorsFromStreams({
              streams,
              extractAnchorTokens,
              maxTokensPerMoment: 25,
              maxAnchors: 200,
            });
          },
        },
        plannedBatches: batches.map((b) => ({
          batchHash: b.batch_hash,
          promptContextHash: b.prompt_context_hash,
        })),
        microStreamHash,
        microMoments: microItems,
        macroSynthesisPromptContext: macroPromptContext ?? null,
        now: input.now,
        documentId: document.id,
      });

      const normalizedStreams = synthesis.streams.map((s) => {
        const macroMoments = Array.isArray((s as any)?.macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        const normalizedMacroMoments = macroMoments.map((m) => ({
          ...m,
          createdAt:
            typeof m?.createdAt === "string" && m.createdAt.trim().length > 0
              ? m.createdAt.trim()
              : defaultCreatedAt,
          author:
            typeof m?.author === "string" && m.author.trim().length > 0
              ? m.author.trim()
              : defaultAuthor,
        }));
        return { ...s, macroMoments: normalizedMacroMoments };
      });
      streamsProduced += synthesis.streams.length;
      for (const s of normalizedStreams) {
        const mm = Array.isArray((s as any).macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        macroMomentsProduced += mm.length;
      }

      await db
        .insertInto("simulation_run_macro_outputs")
        .values({
          run_id: input.runId,
          r2_key: r2Key,
          micro_stream_hash: synthesis.microStreamHash,
          use_llm: 1 as any,
          streams_json: JSON.stringify(normalizedStreams),
          audit_json:
            synthesis.auditEvents.length > 0
              ? JSON.stringify(synthesis.auditEvents)
              : null,
          gating_json: JSON.stringify(synthesis.gating),
          anchors_json: JSON.stringify(synthesis.anchors),
          created_at: input.now,
          updated_at: input.now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            micro_stream_hash: synthesis.microStreamHash,
            use_llm: 1 as any,
            streams_json: JSON.stringify(normalizedStreams),
            audit_json:
              synthesis.auditEvents.length > 0
                ? JSON.stringify(synthesis.auditEvents)
                : null,
            gating_json: JSON.stringify(synthesis.gating),
            anchors_json: JSON.stringify(synthesis.anchors),
            updated_at: input.now,
          } as any)
        )
        .execute();
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
