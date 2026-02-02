import { SimulationDbContext, SimulationPhase } from "./types";
import { getSimulationDb } from "./db";

// Helper function that mimics the standard document polling logic used by
// most phases that process one document at a time.
export function runStandardDocumentPolling(input: {
  phase: SimulationPhase;
  batchSize?: number;
}): (
  context: SimulationDbContext,
  input: { runId: string; phaseIdx: number }
) => Promise<{ status: string; currentPhase: string } | null> {
  const { phase, batchSize = 10 } = input;

  return async (context, { runId }) => {
    const db = getSimulationDb(context);

    // 1. Find documents that have NOT been dispatched for this phase yet
    const pendingDocs = await db
      .selectFrom("simulation_run_documents")
      .select("r2_key")
      .where("run_id", "=", runId)
      // We check if dispatched_phases_json contains the phase.
      // Since it's a JSON string array, we might need a generic "not like" check or similar.
      // Or we can fetch them and filter in memory if the list isn't huge.
      // Given we likely have < 1000 docs in simulation, fetching pending candidates is safer.
      // But we can limit the fetch.
      .execute();

    // Filter in memory for simplicity/sqlite compatibility
    const candidates = pendingDocs.filter((d) => {
      // We don't have the dispatched_phases_json in the select above, let's include it.
      return true;
    });
    
    // Re-select with the column
    const pendingDocsFull = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json"])
      .where("run_id", "=", runId)
      .execute();

    const readyToDispatch = pendingDocsFull.filter((d) => {
      const dispatched = (d.dispatched_phases_json as unknown as string[]) || [];
      return !dispatched.includes(phase);
    });

    if (readyToDispatch.length === 0) {
      // Check if all are processed to potentially advance phase?
      // For now, if no work is left, we return null (idle).
      // The Supervisor will check processed counts to advance.
      return null;
    }

    // Dispatch a batch
    const batch = readyToDispatch.slice(0, batchSize);
    const updates: Promise<any>[] = [];

    // Use the queue
    if ((context.env as any).SIMULATION_QUEUE) {
        for (const doc of batch) {
            updates.push((context.env as any).SIMULATION_QUEUE.send({
                jobType: "simulation-document",
                runId,
                phase,
                r2Key: doc.r2_key
            }));
        }
    }

    await Promise.all(updates);

    // Mark as dispatched
    const now = new Date().toISOString();
    for (const doc of batch) {
      const currentDispatched = (doc.dispatched_phases_json as unknown as string[]) || [];
      const nextDispatched = [...new Set([...currentDispatched, phase])];
      
      await db.updateTable("simulation_run_documents")
        .set({ 
            dispatched_phases_json: nextDispatched as any,
            updated_at: now
        })
        .where("run_id", "=", runId)
        .where("r2_key", "=", doc.r2_key)
        .execute();
    }

    return { status: "running", currentPhase: phase };
  };
}
