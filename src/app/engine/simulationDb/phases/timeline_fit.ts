import { applyMomentGraphNamespacePrefixValue } from "../../momentGraphNamespace";
import type { SimulationDbContext } from "../types";
import { getSimulationDb } from "../db";
import { addSimulationRunEvent } from "../runEvents";
import { createSimulationRunLogger } from "../logger";
import { simulationPhases } from "../types";
import { getMomentGraphDb } from "../db";
import { addMoment, getMoments } from "../../momentDb";

export async function runPhaseTimelineFit(
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
      phase: "timeline_fit",
      r2KeysCount: r2Keys.length,
      effectiveNamespace: effectiveNamespace ?? null,
    },
  });

  const momentGraphContext = {
    env: context.env,
    momentGraphNamespace: effectiveNamespace ?? null,
  };
  const momentDb = getMomentGraphDb(context.env, effectiveNamespace ?? null);

  const candidateRows = (await db
    .selectFrom("simulation_run_candidate_sets")
    .selectAll()
    .where("run_id", "=", input.runId)
    .execute()) as unknown as Array<{
    child_moment_id: string;
    r2_key: string;
    stream_id: string;
    macro_index: number;
    candidates_json: any;
  }>;

  const childIds = candidateRows
    .map((r) => r.child_moment_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const momentsMap = await getMoments(childIds, momentGraphContext);

  let itemsProcessed = 0;
  let attached = 0;
  let rejected = 0;
  let noCandidates = 0;
  let failed = 0;

  for (const row of candidateRows) {
    const childMomentId = row.child_moment_id;
    const child = momentsMap.get(childMomentId) ?? null;
    if (!child) {
      continue;
    }

    const dbChild = await momentDb
      .selectFrom("moments")
      .select(["parent_id"])
      .where("id", "=", childMomentId)
      .executeTakeFirst();
    const alreadyParented =
      typeof (dbChild as any)?.parent_id === "string" &&
      (dbChild as any).parent_id.length > 0;
    if (alreadyParented) {
      continue;
    }

    itemsProcessed++;

    const candidates =
      Array.isArray((row as any).candidates_json) ? (row as any).candidates_json : [];
    const decisions: any[] = [];

    if (!Array.isArray(candidates) || candidates.length === 0) {
      noCandidates++;
      await db
        .insertInto("simulation_run_timeline_fit_decisions")
        .values({
          run_id: input.runId,
          child_moment_id: childMomentId,
          r2_key: row.r2_key,
          stream_id: row.stream_id,
          macro_index: row.macro_index as any,
          outcome: "no_candidates",
          chosen_parent_moment_id: null,
          decisions_json: JSON.stringify([]),
          stats_json: JSON.stringify({ candidateCount: 0 }),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
            r2_key: row.r2_key,
            stream_id: row.stream_id,
            macro_index: row.macro_index as any,
            outcome: "no_candidates",
            chosen_parent_moment_id: null,
            decisions_json: JSON.stringify([]),
            stats_json: JSON.stringify({ candidateCount: 0 }),
            updated_at: now,
          } as any)
        )
        .execute();
      continue;
    }

    const chosen = candidates[0];
    const parentId = typeof chosen?.id === "string" ? chosen.id : null;
    if (!parentId || parentId === childMomentId) {
      noCandidates++;
      await db
        .insertInto("simulation_run_timeline_fit_decisions")
        .values({
          run_id: input.runId,
          child_moment_id: childMomentId,
          r2_key: row.r2_key,
          stream_id: row.stream_id,
          macro_index: row.macro_index as any,
          outcome: "no_candidates",
          chosen_parent_moment_id: null,
          decisions_json: JSON.stringify([]),
          stats_json: JSON.stringify({ candidateCount: candidates.length }),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
            r2_key: row.r2_key,
            stream_id: row.stream_id,
            macro_index: row.macro_index as any,
            outcome: "no_candidates",
            chosen_parent_moment_id: null,
            decisions_json: JSON.stringify([]),
            stats_json: JSON.stringify({ candidateCount: candidates.length }),
            updated_at: now,
          } as any)
        )
        .execute();
      continue;
    }

    decisions.push({
      candidateId: parentId,
      score: typeof chosen?.score === "number" ? chosen.score : null,
      selected: true,
    });

    try {
      const momentWithParent = {
        ...child,
        parentId,
        linkAuditLog: {
          kind: "simulation.timeline_fit",
          chosenCandidate: parentId,
          decisions,
        },
      };
      await addMoment(momentWithParent as any, momentGraphContext);

      const row2 = await momentDb
        .selectFrom("moments")
        .select(["parent_id"])
        .where("id", "=", childMomentId)
        .executeTakeFirst();
      const actualParent =
        typeof (row2 as any)?.parent_id === "string" ? (row2 as any).parent_id : null;

      const ok = actualParent === parentId;
      if (ok) {
        attached++;
      } else {
        rejected++;
        decisions.push({
          candidateId: parentId,
          selected: true,
          rejected: true,
          rejectReason: "write_rejected_by_moment_db",
        });
      }

      await db
        .insertInto("simulation_run_timeline_fit_decisions")
        .values({
          run_id: input.runId,
          child_moment_id: childMomentId,
          r2_key: row.r2_key,
          stream_id: row.stream_id,
          macro_index: row.macro_index as any,
          outcome: ok ? "attached" : "rejected",
          chosen_parent_moment_id: ok ? parentId : null,
          decisions_json: JSON.stringify(decisions),
          stats_json: JSON.stringify({ candidateCount: candidates.length }),
          created_at: now,
          updated_at: now,
        } as any)
        .onConflict((oc) =>
          oc.columns(["run_id", "child_moment_id"]).doUpdateSet({
            r2_key: row.r2_key,
            stream_id: row.stream_id,
            macro_index: row.macro_index as any,
            outcome: ok ? "attached" : "rejected",
            chosen_parent_moment_id: ok ? parentId : null,
            decisions_json: JSON.stringify(decisions),
            stats_json: JSON.stringify({ candidateCount: candidates.length }),
            updated_at: now,
          } as any)
        )
        .execute();
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      await log.error("item.error", {
        phase: "timeline_fit",
        childMomentId,
        r2Key: row.r2_key,
        error: msg,
      });
    }
  }

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "timeline_fit",
      itemsProcessed,
      attached,
      rejected,
      noCandidates,
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
          message: "timeline_fit failed for one or more items",
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "paused_on_error", currentPhase: "timeline_fit" };
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
    return { status: "completed", currentPhase: "timeline_fit" };
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

