import { applyMomentGraphNamespacePrefixValue } from "../../momentGraphNamespace";
import type {
  SimulationDbContext,
  SimulationRunMacroOutputRow,
} from "../types";
import { getMomentGraphDb, getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";
import {
  getIndexingPlugins,
  prepareDocumentForR2Key,
  sha256Hex,
  uuidFromSha256Hex,
} from "../phaseUtils";

export async function runPhaseMaterializeMoments(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select([
      "config_json",
      "moment_graph_namespace",
      "moment_graph_namespace_prefix",
    ])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as unknown as
    | {
        config_json: any;
        moment_graph_namespace: string | null;
        moment_graph_namespace_prefix: string | null;
      }
    | undefined;

  if (!runRow) {
    return null;
  }

  const baseNamespace =
    typeof (runRow as any).moment_graph_namespace === "string"
      ? ((runRow as any).moment_graph_namespace as string)
      : null;
  const prefix =
    typeof (runRow as any).moment_graph_namespace_prefix === "string"
      ? ((runRow as any).moment_graph_namespace_prefix as string)
      : null;
  const effectiveNamespace =
    baseNamespace && prefix
      ? applyMomentGraphNamespacePrefixValue(baseNamespace, prefix)
      : baseNamespace;

  const config = (runRow as any).config_json ?? {};
  const r2KeysRaw = (config as any)?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: {
      phase: "materialize_moments",
      r2KeysCount: r2Keys.length,
      effectiveNamespace: effectiveNamespace ?? null,
    },
  });

  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  let momentsUpserted = 0;
  let docsSkippedUnchanged = 0;
  let docsProcessed = 0;
  let failed = 0;

  const failures: Array<{ r2Key: string; error: string }> = [];
  const plugins = getIndexingPlugins(context.env);

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

    const macroRow = (await db
      .selectFrom("simulation_run_macro_outputs")
      .select(["streams_json"])
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", r2Key)
      .executeTakeFirst()) as unknown as
      | SimulationRunMacroOutputRow
      | undefined;

    if (!macroRow) {
      continue;
    }

    docsProcessed++;

    const streamsAny = (macroRow as any).streams_json;
    const streams = Array.isArray(streamsAny)
      ? (streamsAny as any[])
      : typeof streamsAny === "string"
      ? (() => {
          try {
            return JSON.parse(streamsAny);
          } catch {
            return [];
          }
        })()
      : [];

    try {
      const { document } = await prepareDocumentForR2Key(
        r2Key,
        context.env,
        plugins
      );

      for (const stream of streams) {
        const streamId =
          typeof (stream as any)?.streamId === "string"
            ? (stream as any).streamId
            : "stream";
        const macroMoments = Array.isArray((stream as any)?.macroMoments)
          ? ((stream as any).macroMoments as any[])
          : [];

        for (let i = 0; i < macroMoments.length; i++) {
          const m = macroMoments[i] ?? {};
          const title =
            typeof m.title === "string" && m.title.trim().length > 0
              ? m.title.trim()
              : "(untitled)";
          const summary =
            typeof m.summary === "string" && m.summary.trim().length > 0
              ? m.summary.trim()
              : "(empty)";
          const createdAt =
            typeof m.createdAt === "string" && m.createdAt.trim().length > 0
              ? m.createdAt.trim()
              : now;
          const author =
            typeof m.author === "string" && m.author.trim().length > 0
              ? m.author.trim()
              : "machinen";
          const microPaths = Array.isArray(m.microPaths)
            ? m.microPaths.filter((p: any) => typeof p === "string")
            : null;
          const microPathsHash =
            microPaths && microPaths.length > 0
              ? await sha256Hex(microPaths.join("\n"))
              : null;

          const rawId = await sha256Hex(
            [
              "simulation-materialize-moment",
              input.runId,
              effectiveNamespace ?? "",
              document.id,
              streamId,
              String(i),
            ].join("\n")
          );
          const momentId = uuidFromSha256Hex(rawId);

          await momentDb
            .insertInto("moments")
            .values({
              id: momentId,
              document_id: document.id,
              summary,
              title,
              parent_id: null as any,
              micro_paths_json: microPaths
                ? JSON.stringify(microPaths)
                : (null as any),
              micro_paths_hash: (microPathsHash ?? null) as any,
              importance:
                typeof m.importance === "number" &&
                Number.isFinite(m.importance)
                  ? (m.importance as any)
                  : (null as any),
              link_audit_log: null as any,
              is_subject: (m.isSubject === true ? 1 : 0) as any,
              subject_kind:
                typeof m.subjectKind === "string"
                  ? (m.subjectKind as any)
                  : (null as any),
              subject_reason:
                typeof m.subjectReason === "string"
                  ? (m.subjectReason as any)
                  : (null as any),
              subject_evidence_json: Array.isArray(m.subjectEvidence)
                ? (JSON.stringify(m.subjectEvidence) as any)
                : (null as any),
              moment_kind:
                typeof m.momentKind === "string"
                  ? (m.momentKind as any)
                  : (null as any),
              moment_evidence_json: Array.isArray(m.momentEvidence)
                ? (JSON.stringify(m.momentEvidence) as any)
                : (null as any),
              created_at: createdAt,
              author,
              source_metadata:
                typeof m.sourceMetadata === "object" && m.sourceMetadata
                  ? (JSON.stringify(m.sourceMetadata) as any)
                  : (JSON.stringify({
                      simulation: {
                        runId: input.runId,
                        r2Key,
                        streamId,
                        macroIndex: i,
                      },
                    }) as any),
            } as any)
            .onConflict((oc) =>
              oc.column("id").doUpdateSet({
                summary,
                title,
                parent_id: null as any,
                micro_paths_json: microPaths
                  ? JSON.stringify(microPaths)
                  : (null as any),
                micro_paths_hash: (microPathsHash ?? null) as any,
                importance:
                  typeof m.importance === "number" &&
                  Number.isFinite(m.importance)
                    ? (m.importance as any)
                    : (null as any),
                is_subject: (m.isSubject === true ? 1 : 0) as any,
                subject_kind:
                  typeof m.subjectKind === "string"
                    ? (m.subjectKind as any)
                    : (null as any),
                subject_reason:
                  typeof m.subjectReason === "string"
                    ? (m.subjectReason as any)
                    : (null as any),
                subject_evidence_json: Array.isArray(m.subjectEvidence)
                  ? (JSON.stringify(m.subjectEvidence) as any)
                  : (null as any),
                moment_kind:
                  typeof m.momentKind === "string"
                    ? (m.momentKind as any)
                    : (null as any),
                moment_evidence_json: Array.isArray(m.momentEvidence)
                  ? (JSON.stringify(m.momentEvidence) as any)
                  : (null as any),
                created_at: createdAt,
                author,
              } as any)
            )
            .execute();

          await db
            .insertInto("simulation_run_materialized_moments")
            .values({
              run_id: input.runId,
              r2_key: r2Key,
              stream_id: streamId,
              macro_index: i as any,
              moment_id: momentId,
              created_at: now,
              updated_at: now,
            } as any)
            .onConflict((oc) =>
              oc
                .columns(["run_id", "r2_key", "stream_id", "macro_index"])
                .doUpdateSet({
                  moment_id: momentId,
                  updated_at: now,
                } as any)
            )
            .execute();

          momentsUpserted++;
        }
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      failures.push({ r2Key, error: msg });
      await log.error("item.error", {
        phase: "materialize_moments",
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
      phase: "materialize_moments",
      r2KeysCount: r2Keys.length,
      docsProcessed,
      docsSkippedUnchanged,
      momentsUpserted,
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
          message: "materialize_moments failed for one or more documents",
          failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();

    return { status: "paused_on_error", currentPhase: "materialize_moments" };
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
    return { status: "completed", currentPhase: "materialize_moments" };
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
