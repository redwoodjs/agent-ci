import { getSimulationDb } from "./db";
import { addSimulationRunEvent } from "./runEvents";
import { SimulationDbContext, SimulationPhase } from "./types";
import { WorkUnit } from "./registry";

/**
 * Standard factory for onTick orchestration in document-based phases.
 * Handles:
 * 1. Cooldown-based polling (retry strategy).
 * 2. Dispatching to the execution queue.
 * 3. State transitions (awaiting_documents vs advance).
 */
export function runStandardDocumentPolling(options: {
  phase: SimulationPhase;
}) {
  return async (
    context: SimulationDbContext,
    input: { runId: string }
  ): Promise<{ status: string; currentPhase: string } | null> => {
    const db = getSimulationDb(context);
    const isDev = !!process.env.VITE_IS_DEV_SERVER;
    const cooldownMs = isDev ? 30 * 1000 : 10 * 60 * 1000;
    const cooldownDate = new Date(Date.now() - cooldownMs).toISOString();

    // 1. Identify "Pollable" Documents:
    // - NOT yet processed in this phase
    // - AND (never failed OR failed but past cooldown)
    const pollableDocs = await db
      .selectFrom("simulation_run_documents")
      .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
      .where("run_id", "=", input.runId)
      .where((eb: any) =>
        eb.or([
          eb("error_json", "is", null),
          eb("updated_at", "<", cooldownDate),
        ])
      )
      .execute();

    // Filter out docs already processed or currently dispatched
    const undispatched = pollableDocs.filter((doc) => {
      const processed = (doc.processed_phases_json || []) as string[];
      const dispatched = (doc.dispatched_phases_json || []) as string[];
      return !processed.includes(options.phase) && !dispatched.includes(options.phase);
    });

    if (undispatched.length > 0) {
      // 2. Dispatch Work Units
      await addSimulationRunEvent(context, {
        runId: input.runId,
        level: "info",
        kind: "host.dispatch.work",
        payload: { 
          phase: options.phase, 
          count: undispatched.length, 
          sample: undispatched[0].r2_key 
        },
      });

      for (const doc of undispatched) {
        // Update dispatched_phases_json
        const currentDispatched = (doc.dispatched_phases_json || []) as string[];
        const nextDispatched = Array.from(new Set([...currentDispatched, options.phase]));
        
        await db
          .updateTable("simulation_run_documents")
          .set({ 
            dispatched_phases_json: nextDispatched as any, 
            updated_at: new Date().toISOString() 
          })
          .where("run_id", "=", input.runId)
          .where("r2_key", "=", doc.r2_key)
          .execute();

        // Enqueue job
        await context.env.ENGINE_INDEXING_QUEUE.send({
          jobType: "simulation-document",
          runId: input.runId,
          phase: options.phase,
          r2Key: doc.r2_key,
        });
      }

      return { status: "awaiting_documents", currentPhase: options.phase };
    }

    // 3. Check if all docs are actually processed for this phase
    const totalDocs = await db
      .selectFrom("simulation_run_documents")
      .select(["processed_phases_json", "changed"])
      .where("run_id", "=", input.runId)
      .execute();
      
    const allProcessed = totalDocs.every((doc) => {
        const processed = (doc.processed_phases_json || []) as string[];
        return processed.includes(options.phase);
    });

    if (allProcessed && totalDocs.length > 0) {
      return { status: "advance", currentPhase: options.phase };
    }

    // Special case: if no docs were found at all, advance
    if (totalDocs.length === 0) {
        return { status: "advance", currentPhase: options.phase };
    }

    return { status: "awaiting_documents", currentPhase: options.phase };
  };
}
