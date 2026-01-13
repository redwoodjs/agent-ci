import { applyMomentGraphNamespacePrefixValue } from "../../momentGraphNamespace";
import type { SimulationDbContext } from "../types";
import { getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";
import { getMomentGraphDb } from "../db";
import { getEmbedding } from "../../utils/vector";
import { buildCandidateSet } from "../../phaseCores/candidate_sets_core";

function parseTimeMs(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

function readTimeRangeStartMs(value: unknown): number | null {
  const range = (value as any)?.timeRange;
  const start = range?.start;
  return parseTimeMs(start);
}

function computeMomentStartMs(input: {
  createdAt: string;
  sourceMetadata?: Record<string, any>;
}): number | null {
  const rangeStart = readTimeRangeStartMs(input.sourceMetadata);
  if (rangeStart !== null) {
    return rangeStart;
  }
  return parseTimeMs(input.createdAt);
}

export async function runPhaseCandidateSets(
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
      phase: "candidate_sets",
      r2KeysCount: r2Keys.length,
      effectiveNamespace: effectiveNamespace ?? null,
    },
  });

  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  const mapped = (await db
    .selectFrom("simulation_run_materialized_moments")
    .selectAll()
    .where("run_id", "=", input.runId)
    .execute()) as unknown as Array<{
    r2_key: string;
    stream_id: string;
    macro_index: number;
    moment_id: string;
  }>;

  const roots = mapped.filter((m) => Number(m.macro_index ?? 0) === 0);
  const rootIds = roots.map((r) => r.moment_id).filter(Boolean);
  const parentRows =
    rootIds.length > 0
      ? await momentDb
          .selectFrom("moments")
          .select(["id", "parent_id", "document_id", "created_at", "source_metadata"])
          .where("id", "in", rootIds as any)
          .execute()
      : [];
  const rootById = new Map((parentRows as any[]).map((r) => [r.id, r]));

  const maxCandidates = (() => {
    const raw = (context.env as any).SIMULATION_CANDIDATE_SET_MAX;
    const n =
      typeof raw === "string"
        ? Number.parseInt(raw, 10)
        : typeof raw === "number"
        ? raw
        : 10;
    return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 10;
  })();
  const vectorTopK = Math.max(10, maxCandidates * 3);

  let itemsProcessed = 0;
  let setsWritten = 0;
  let failed = 0;

  for (const root of roots) {
    const childMomentId = root.moment_id;
    const childRow = rootById.get(childMomentId) as any;
    if (!childRow) {
      continue;
    }
    const alreadyParented =
      typeof childRow.parent_id === "string" && childRow.parent_id.length > 0;
    if (alreadyParented) {
      continue;
    }

    itemsProcessed++;

    const queryText =
      (typeof childRow.summary === "string" && childRow.summary.trim()) ||
      (typeof childRow.title === "string" && childRow.title.trim()) ||
      "";
    if (!queryText) {
      await db
        .insertInto("simulation_run_candidate_sets")
        .values({
          run_id: input.runId,
          child_moment_id: childMomentId,
          r2_key: root.r2_key,
          stream_id: root.stream_id,
          macro_index: root.macro_index as any,
          candidates_json: JSON.stringify([]),
          stats_json: JSON.stringify({ reason: "empty-query" }),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
            r2_key: root.r2_key,
            stream_id: root.stream_id,
            macro_index: root.macro_index as any,
            candidates_json: JSON.stringify([]),
            stats_json: JSON.stringify({ reason: "empty-query" }),
            updated_at: now,
          } as any)
        )
        .execute();
      setsWritten++;
      continue;
    }

    try {
      const embedding = await getEmbedding(queryText);
      const results = await (context.env as any).MOMENT_INDEX.query(embedding, {
        topK: vectorTopK,
        returnMetadata: true,
        filter:
          (effectiveNamespace ?? "default") !== "default"
            ? { momentGraphNamespace: effectiveNamespace ?? "default" }
            : undefined,
      });

      const matchIds = (results?.matches ?? [])
        .map((m: any) => (typeof m?.id === "string" ? m.id : null))
        .filter(Boolean);

      const uniqueIds = Array.from(new Set(matchIds)).slice(0, vectorTopK);
      const rows = uniqueIds.length
        ? await momentDb
            .selectFrom("moments")
            .select([
              "id",
              "document_id",
              "created_at",
              "source_metadata",
              "title",
              "summary",
            ])
            .where("id", "in", uniqueIds as any)
            .execute()
        : [];
      const byId = new Map((rows as any[]).map((r) => [r.id, r]));

      const childStartMs =
        computeMomentStartMs({
          createdAt: childRow.created_at,
          sourceMetadata: childRow.source_metadata ?? undefined,
        }) ?? null;

      const built = buildCandidateSet({
        childMomentId,
        childDocumentId: childRow.document_id,
        childStartMs,
        matches: (results?.matches ?? []).map((m: any) => ({
          id: typeof m?.id === "string" ? m.id : "",
          score: typeof m?.score === "number" ? m.score : null,
        })),
        candidateRowsById: byId as any,
        maxCandidates,
      });
      const candidates = built.candidates;

      await db
        .insertInto("simulation_run_candidate_sets")
        .values({
          run_id: input.runId,
          child_moment_id: childMomentId,
          r2_key: root.r2_key,
          stream_id: root.stream_id,
          macro_index: root.macro_index as any,
          candidates_json: JSON.stringify(candidates),
          stats_json: JSON.stringify({
            ...built.stats,
            vectorTopK,
          }),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
            r2_key: root.r2_key,
            stream_id: root.stream_id,
            macro_index: root.macro_index as any,
            candidates_json: JSON.stringify(candidates),
            stats_json: JSON.stringify({
              ...built.stats,
              vectorTopK,
            }),
            updated_at: now,
          } as any)
        )
        .execute();
      setsWritten++;
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", {
        phase: "candidate_sets",
        childMomentId,
        r2Key: root.r2_key,
        error: msg,
      });
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "candidate_sets",
      itemsProcessed,
      setsWritten,
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
          message: "candidate_sets failed for one or more items",
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "paused_on_error", currentPhase: "candidate_sets" };
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
    return { status: "completed", currentPhase: "candidate_sets" };
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

