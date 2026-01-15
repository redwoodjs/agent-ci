import type { SimulationDbContext } from "../../../adapters/simulation/types";
import { getSimulationDb } from "../../../adapters/simulation/db";
import { addSimulationRunEvent } from "../../../adapters/simulation/runEvents";
import { createSimulationRunLogger } from "../../../adapters/simulation/logger";
import { simulationPhases } from "../../../adapters/simulation/types";
import { runMacroSynthesisAdapter } from "./adapter";
import { synthesizeMicroMomentsIntoStreams } from "../../../synthesis/synthesizeMicroMoments";

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

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { phase: "macro_synthesis", r2KeysCount: r2Keys.length },
  });

  const result = await runMacroSynthesisAdapter(context, {
    runId: input.runId,
    r2Keys,
    now,
    log,
    ports: { synthesizeMicroMomentsIntoStreams },
  });

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: result.failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "macro_synthesis",
      r2KeysCount: r2Keys.length,
      docsProcessed: result.docsProcessed,
      docsReused: result.docsReused,
      docsSkippedUnchanged: result.docsSkippedUnchanged,
      streamsProduced: result.streamsProduced,
      macroMomentsProduced: result.macroMomentsProduced,
      failed: result.failed,
    },
  });

  if (result.failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "macro_synthesis failed for one or more documents",
          failures: result.failures,
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

