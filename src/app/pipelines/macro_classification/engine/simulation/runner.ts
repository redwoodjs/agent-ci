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

  // 1. Get relevant documents (those that were changed in previous steps)
  const changedDocs = await db
    .selectFrom("simulation_run_documents")
    .select("r2_key")
    .where("run_id", "=", input.runId)
    .where("changed", "=", 1)
    .where("error_json", "is", null)
    .execute();
  
  const relevantR2Keys = changedDocs.map(d => d.r2_key);

  if (!input.r2Key) {
    // Polling / Startup mode
    if (relevantR2Keys.length === 0) {
      // No docs to process? Advance.
      return advance(db, input.runId, input.phaseIdx, now);
    }

    const processedRows = await db
      .selectFrom("simulation_run_macro_classified_outputs")
      .select("r2_key")
      .where("run_id", "=", input.runId)
      .execute();
    
    const processedSet = new Set(processedRows.map(r => r.r2_key));
    const missingKeys = relevantR2Keys.filter(k => !processedSet.has(k));

    if (missingKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "macro_classification", count: missingKeys.length },
        });

        for (const k of missingKeys) {
          await queue.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase: "macro_classification",
            r2Key: k,
          });
        }
        return { status: "running", currentPhase: "macro_classification" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    // All done? Check if we had errors (actually the adapter might log errors elsewhere, 
    // but here we check if those that WERE relevant survived).
    // For now, if missingKeys.length === 0, we assume we finished.
    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  const result = await runMacroClassificationAdapter(context, {
    runId: input.runId,
    r2Keys: [input.r2Key],
    now,
    log,
    ports: {
      callLLM: async (prompt) =>
        await callLLM(prompt, "slow-reasoning", { temperature: 0 }),
    },
  });

  if (result.failed > 0) {
    // The adapter already persists errors in some ways, but let's ensure the run knows
    // Actually, the adapter doesn't seem to persist "error rows" in macro_classified_outputs
    // We should probably rely on the host runner to see errors if we want to pause.
  }

  return { status: "running", currentPhase: "macro_classification" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "macro_classification" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
