import type { SimulationDbContext } from "../../simulation/types";
import type { SimulationPhase } from "../../simulation/types";
import { simulationPhases } from "../../simulation/types";
import { normalizePhase } from "../../simulation/runs";
import { getSimulationDb } from "../../simulation/db";
import { addSimulationRunEvent } from "../../simulation/runEvents";
import { pipelineRegistry } from "../../simulation/allPipelines";

// No longer need hardcoded phaseRunners mapping here


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

  await addSimulationRunEvent(context, {
    runId,
    level: "debug",
    kind: "host.phase.dispatch",
    payload: { phase, phaseIdx },
  });

  try {
    const entry = pipelineRegistry[phase];
    if (!entry) {
      throw new Error(`No registry entry found for phase: ${phase}`);
    }
    return await entry.runner(context, { runId, phaseIdx });
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    await addSimulationRunEvent(context, {
      runId,
      level: "error",
      kind: "phase.error",
      payload: { phase, error: msg, stack },
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
          stack,
        }),
      } as any)
      .where("run_id", "=", runId)
      .execute();

    return { status: "paused_on_error", currentPhase: phase };
  }
}

