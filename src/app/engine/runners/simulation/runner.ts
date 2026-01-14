import type { SimulationDbContext } from "../../adapters/simulation/types";
import { simulationPhases } from "../../adapters/simulation/types";
import { normalizePhase } from "../../adapters/simulation/runs";
import { getSimulationDb } from "../../adapters/simulation/db";
import { addSimulationRunEvent } from "../../adapters/simulation/runEvents";
import { runPhaseIngestDiff } from "./phases/ingest_diff";
import { runPhaseMicroBatches } from "./phases/micro_batches";
import { runPhaseMacroSynthesis } from "./phases/macro_synthesis";
import { runPhaseMaterializeMoments } from "./phases/materialize_moments";
import { runPhaseDeterministicLinking } from "./phases/deterministic_linking";
import { runPhaseCandidateSets } from "./phases/candidate_sets";
import { runPhaseTimelineFit } from "./phases/timeline_fit";

export async function advanceSimulationRunPhaseNoop(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const runId =
    typeof input.runId === "string" && input.runId.trim().length > 0
      ? input.runId.trim()
      : "";
  if (!runId) {
    return null;
  }

  const row = (await db
    .selectFrom("simulation_runs")
    .select(["status", "current_phase"])
    .where("run_id", "=", runId)
    .executeTakeFirst()) as unknown as
    | { status: string; current_phase: string }
    | undefined;

  if (!row) {
    return null;
  }

  if (row.status !== "running") {
    return { status: row.status, currentPhase: row.current_phase };
  }

  const phase = normalizePhase(row.current_phase);
  const phaseIdx = simulationPhases.indexOf(phase);

  try {
    if (phase === "ingest_diff") {
      return await runPhaseIngestDiff(context, { runId, phaseIdx });
    }
    if (phase === "micro_batches") {
      return await runPhaseMicroBatches(context, { runId, phaseIdx });
    }
    if (phase === "macro_synthesis") {
      return await runPhaseMacroSynthesis(context, { runId, phaseIdx });
    }
    if (phase === "materialize_moments") {
      return await runPhaseMaterializeMoments(context, { runId, phaseIdx });
    }
    if (phase === "deterministic_linking") {
      return await runPhaseDeterministicLinking(context, { runId, phaseIdx });
    }
    if (phase === "candidate_sets") {
      return await runPhaseCandidateSets(context, { runId, phaseIdx });
    }
    if (phase === "timeline_fit") {
      return await runPhaseTimelineFit(context, { runId, phaseIdx });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: "phase.error",
      payload: { phase, error: msg },
    });
    const now = new Date().toISOString();
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: msg,
          phase,
        }),
      } as any)
      .where("run_id", "=", runId)
      .execute();
    return { status: "paused_on_error", currentPhase: phase };
  }

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "phase.start",
    payload: { phase },
  });

  await addSimulationRunEvent(context, {
    runId,
    level: "info",
    kind: "phase.end",
    payload: { phase, didWork: false },
  });

  const now = new Date().toISOString();
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;

  if (!nextPhase) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "completed",
        updated_at: now,
        last_progress_at: now,
      } as any)
      .where("run_id", "=", runId)
      .execute();
    return { status: "completed", currentPhase: phase };
  }

  await db
    .updateTable("simulation_runs")
    .set({
      current_phase: nextPhase,
      updated_at: now,
      last_progress_at: now,
    } as any)
    .where("run_id", "=", runId)
    .execute();

  return { status: "running", currentPhase: nextPhase };
}

