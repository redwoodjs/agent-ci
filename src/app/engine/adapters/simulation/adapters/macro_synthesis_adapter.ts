import type { SimulationDbContext, SimulationMicroBatchCacheRow } from "../types";
import { getSimulationDb } from "../db";
import { getIndexingPlugins } from "../../indexing/indexingPlugins";
import { prepareDocumentForR2Key } from "../../indexing/pluginPipeline";
import { synthesizeMicroMomentsIntoStreams } from "../../synthesis/synthesizeMicroMoments";
import { computeMicroStreamHash, extractAnchorsFromStreams } from "../../lib/phaseCores/macro_synthesis_core";
import { sha256Hex } from "../../utils/crypto";
import { extractAnchorTokens } from "../../utils/anchorTokens";

export async function runMacroSynthesisAdapter(
  context: SimulationDbContext,
  input: {
    runId: string;
    r2Keys: string[];
    useLlm: boolean;
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
          const v =
            await plugin.subjects?.getMacroSynthesisPromptContext?.(
              document,
              indexingContext
            );
          if (v !== null && v !== undefined) {
            return v;
          }
        }
        return null;
      })();

      const microItems: Array<{
        path: string;
        summary: string;
        createdAt: string;
      }> = [];

      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
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
            path: `${r2Key}#${i}#${j}`,
            summary: asStrings[j],
            createdAt: input.now,
          });
        }
      }

      const auditEvents: any[] = [];

      let streams: any[] = [];
      if (input.useLlm) {
        const llmStreams = await synthesizeMicroMomentsIntoStreams(
          microItems.map((m) => ({ ...m } as any)),
          {
            macroSynthesisPromptContext: macroPromptContext ?? null,
            auditSink: (event) => {
              auditEvents.push(event);
            },
          }
        );
        streams = llmStreams;
      } else {
        const summaries = microItems
          .map((m) => m.summary)
          .filter(Boolean)
          .slice(0, 24);
        const groups: string[][] = [];
        for (let i = 0; i < summaries.length; i += 8) {
          groups.push(summaries.slice(i, i + 8));
        }
        const fallbackGroups = groups.length > 0 ? groups : [["(empty)"]];
        while (fallbackGroups.length < 3) {
          fallbackGroups.push(["(empty)"]);
        }
        const macroMoments = fallbackGroups.slice(0, 3).map((g, idx) => ({
          title: `Synthesis for ${document.id} (${idx + 1})`,
          summary: g.join(" ") || "(empty)",
          microPaths: microItems
            .slice(idx * 16, idx * 16 + 50)
            .map((m) => m.path),
          importance: 0.5,
          createdAt: new Date(Date.parse(input.now) + idx * 60_000).toISOString(),
        }));
        streams = [
          {
            streamId: "stream-1",
            macroMoments,
          },
        ];
      }

      const anchors = extractAnchorsFromStreams({
        streams,
        extractAnchorTokens,
        maxTokensPerMoment: 25,
        maxAnchors: 200,
      });

      const gating = {
        keptStreams: streams.length,
        droppedStreams: 0,
      };

      streamsProduced += streams.length;
      for (const s of streams) {
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
          micro_stream_hash: microStreamHash,
          use_llm: input.useLlm ? (1 as any) : (0 as any),
          streams_json: JSON.stringify(streams),
          audit_json: auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
          gating_json: JSON.stringify(gating),
          anchors_json: JSON.stringify(anchors),
          created_at: input.now,
          updated_at: input.now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            micro_stream_hash: microStreamHash,
            use_llm: input.useLlm ? (1 as any) : (0 as any),
            streams_json: JSON.stringify(streams),
            audit_json:
              auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
            gating_json: JSON.stringify(gating),
            anchors_json: JSON.stringify(anchors),
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

