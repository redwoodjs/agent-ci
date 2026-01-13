import type { SimulationDbContext, SimulationMicroBatchCacheRow } from "../types";
import { getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";
import {
  extractAnchorTokens,
  getIndexingPlugins,
  prepareDocumentForR2Key,
  sha256Hex,
} from "../phaseUtils";
import { synthesizeMicroMomentsIntoStreams } from "../../synthesis/synthesizeMicroMoments";

export async function runPhaseMacroSynthesis(
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

  const env = context.env;
  const useLlm = String((env as any).SIMULATION_MACRO_USE_LLM ?? "") === "1";

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "macro_synthesis", r2KeysCount: r2Keys.length, useLlm },
  });

  const plugins = getIndexingPlugins(env);

  let docsProcessed = 0;
  let docsReused = 0;
  let docsSkippedUnchanged = 0;
  let failed = 0;
  let streamsProduced = 0;
  let macroMomentsProduced = 0;

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

      const identityParts = batches.map(
        (b) => `${b.batch_hash}:${b.prompt_context_hash}`
      );
      const microStreamHash = await sha256Hex(identityParts.join("\n"));

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
            createdAt: now,
          });
        }
      }

      const auditEvents: any[] = [];

      let streams: any[] = [];
      if (useLlm) {
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
        const joined = microItems
          .map((m) => m.summary)
          .filter(Boolean)
          .slice(0, 8)
          .join(" ");
        streams = [
          {
            streamId: "stream-1",
            macroMoments: [
              {
                title: `Synthesis for ${document.id}`,
                summary: joined || "(empty)",
                microPaths: microItems.slice(0, 50).map((m) => m.path),
                importance: 0.5,
                createdAt: now,
              },
            ],
          },
        ];
      }

      const anchors: string[] = [];
      for (const s of streams) {
        const moments = Array.isArray((s as any).macroMoments)
          ? ((s as any).macroMoments as any[])
          : [];
        for (const m of moments) {
          const text = `${m.title ?? ""}\n${m.summary ?? ""}`.trim();
          for (const tok of extractAnchorTokens(text, 25)) {
            anchors.push(tok);
          }
        }
      }

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
          use_llm: useLlm ? (1 as any) : (0 as any),
          streams_json: JSON.stringify(streams),
          audit_json: auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
          gating_json: JSON.stringify(gating),
          anchors_json: JSON.stringify(anchors.slice(0, 200)),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "r2_key"]).doUpdateSet({
            micro_stream_hash: microStreamHash,
            use_llm: useLlm ? (1 as any) : (0 as any),
            streams_json: JSON.stringify(streams),
            audit_json:
              auditEvents.length > 0 ? JSON.stringify(auditEvents) : null,
            gating_json: JSON.stringify(gating),
            anchors_json: JSON.stringify(anchors.slice(0, 200)),
            updated_at: now,
          } as any)
        )
        .execute();
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "macro_synthesis",
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
      phase: "macro_synthesis",
      useLlm,
      r2KeysCount: r2Keys.length,
      docsProcessed,
      docsReused,
      docsSkippedUnchanged,
      streamsProduced,
      macroMomentsProduced,
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
          message: "macro_synthesis failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "macro_synthesis" };
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
    return { status: "completed", currentPhase: "macro_synthesis" };
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

