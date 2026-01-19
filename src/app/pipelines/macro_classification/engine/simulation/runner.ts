import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runMacroClassificationAdapter } from "./adapter";
import { callLLM } from "../../../../engine/utils/llm";

export async function runPhaseMacroClassification(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  const runRow = (await db
    .selectFrom("simulation_runs")
    .select(["config_json"])
    .where("run_id", "=", input.runId)
    .executeTakeFirst()) as any;
  if (!runRow) {
    return null;
  }

  const config = runRow?.config_json ?? {};
  const r2KeysRaw = config?.r2Keys;
  const r2Keys =
    Array.isArray(r2KeysRaw) && r2KeysRaw.every((k: any) => typeof k === "string")
      ? (r2KeysRaw as string[])
      : [];

  if (!input.r2Key) {
    const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
    if (queue && r2Keys.length > 0) {
      await addSimulationRunEvent(context, {
        runId: input.runId,
        level: "info",
        kind: "phase.dispatch_docs",
        payload: { phase: "macro_classification", count: r2Keys.length },
      });

      for (const r2Key of r2Keys) {
        await queue.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase: "macro_classification",
          r2Key,
        });
      }
      return { status: "running", currentPhase: "macro_classification" };
    }
  }

  const activeR2Keys = input.r2Key ? [input.r2Key] : r2Keys;

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "info",
    kind: "phase.start",
    payload: { 
      phase: "macro_classification", 
      r2KeysCount: activeR2Keys.length,
      isGranular: !!input.r2Key
    },
  });

  const result = await runMacroClassificationAdapter(context, {
    runId: input.runId,
    r2Keys: activeR2Keys,
    now,
    log,
    ports: {
      callLLM: async (prompt) =>
        await callLLM(prompt, "slow-reasoning", {
          temperature: 0,
          logger: (msg, data) => {
            log
              .info("process.llm_retry", {
                phase: "macro_classification",
                msg,
                ...data,
              })
              .catch(() => {});
          },
        }),
    },
  });

  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: result.failed > 0 ? "error" : "info",
    kind: "phase.end",
    payload: {
      phase: "macro_classification",
      r2KeysCount: r2Keys.length,
      docsProcessed: result.docsProcessed,
      streamsIn: result.streamsIn,
      streamsOut: result.streamsOut,
      macroIn: result.macroIn,
      macroOut: result.macroOut,
      failed: result.failed,
    },
  });

  if (input.r2Key) {
    if ((context.env as any).ENGINE_INDEXING_QUEUE) {
       await (context.env as any).ENGINE_INDEXING_QUEUE.send({
         jobType: "simulation-advance",
         runId: input.runId,
       });
    }
    return { status: "running", currentPhase: "macro_classification" };
  }

  if (result.failed > 0) {
    await db
      .updateTable("simulation_runs")
      .set({
        status: "paused_on_error",
        updated_at: now,
        last_progress_at: now,
        last_error_json: JSON.stringify({
          message: "macro_classification failed for one or more documents",
          failures: result.failures,
        }),
      } as any)
      .where("run_id", "=", input.runId)
      .execute();
    return { status: "paused_on_error", currentPhase: "macro_classification" };
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
    return { status: "completed", currentPhase: "macro_classification" };
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

