import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import { createSimulationRunLogger } from "../../../../engine/simulation/logger";
import { simulationPhases } from "../../../../engine/simulation/types";
import { runMacroSynthesisAdapter } from "./adapter";
import { synthesizeMicroMomentsIntoStreams } from "../../../../engine/synthesis/synthesizeMicroMoments";

export async function runPhaseMacroSynthesis(
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number; r2Key?: string }
): Promise<{ status: string; currentPhase: string } | null> {
  const db = getSimulationDb(context);
  const now = new Date().toISOString();
  const log = createSimulationRunLogger(context, { runId: input.runId });

  // 1. Get relevant documents (those that were changed in ingest_diff)
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
      return advance(db, input.runId, input.phaseIdx, now);
    }

    const processedRows = await db
      .selectFrom("simulation_run_macro_outputs")
      .select("r2_key")
      .where("run_id", "=", input.runId)
      .execute();
    
    const docDispatchRows = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json"])
      .where("run_id", "=", input.runId)
      .execute();

    const processedSet = new Set(processedRows.map(r => r.r2_key));
    const dispatchMap = new Map(docDispatchRows.map(r => [r.r2_key, JSON.parse(r.dispatched_phases_json || "[]") as string[]]));

    const missingKeys = relevantR2Keys.filter(k => !processedSet.has(k));
    const undecpatchedKeys = relevantR2Keys.filter(k => {
      if (processedSet.has(k)) return false;
      const dispatched = dispatchMap.get(k) || [];
      return !dispatched.includes("macro_synthesis");
    });

    if (undecpatchedKeys.length > 0) {
      const queue = (context.env as any).ENGINE_INDEXING_QUEUE;
      if (queue) {
        await addSimulationRunEvent(context, {
          runId: input.runId,
          level: "info",
          kind: "phase.dispatch_docs",
          payload: { phase: "macro_synthesis", count: undecpatchedKeys.length },
        });

        for (const k of undecpatchedKeys) {
          const dispatched = dispatchMap.get(k) || [];
          const nextDispatched = [...new Set([...dispatched, "macro_synthesis"])];
          
          await db.updateTable("simulation_run_documents")
            .set({ dispatched_phases_json: JSON.stringify(nextDispatched), updated_at: now })
            .where("run_id", "=", input.runId)
            .where("r2_key", "=", k)
            .execute();

          await queue.send({
            jobType: "simulation-document",
            runId: input.runId,
            phase: "macro_synthesis",
            r2Key: k,
          });
        }
        return { status: "awaiting_documents", currentPhase: "macro_synthesis" };
      }
      throw new Error("ENGINE_INDEXING_QUEUE is required");
    }

    if (missingKeys.length > 0) {
      return { status: "awaiting_documents", currentPhase: "macro_synthesis" };
    }

    return advance(db, input.runId, input.phaseIdx, now);
  }

  // Granular execution
  await runMacroSynthesisAdapter(context, {
    runId: input.runId,
    r2Keys: [input.r2Key],
    now,
    log,
    ports: { synthesizeMicroMomentsIntoStreams },
  });

  return { status: "running", currentPhase: "macro_synthesis" };
}

async function advance(db: any, runId: string, phaseIdx: number, now: string) {
  const nextPhase = simulationPhases[phaseIdx + 1] ?? null;
  if (!nextPhase) {
    await db.updateTable("simulation_runs").set({ status: "completed", updated_at: now }).where("run_id", "=", runId).execute();
    return { status: "completed", currentPhase: "macro_synthesis" };
  }
  await db.updateTable("simulation_runs").set({ current_phase: nextPhase, updated_at: now }).where("run_id", "=", runId).execute();
  return { status: "running", currentPhase: nextPhase };
}
