import { getSimulationDb } from "../../../../engine/simulation/db";
import { addSimulationRunEvent } from "../../../../engine/simulation/runEvents";
import type { SimulationDbContext } from "../../../../engine/simulation/types";
import { recoverZombiesForPhase } from "../../../../engine/simulation/resiliency";

export async function recoverMicroBatchZombies(
  context: SimulationDbContext,
  input: { runId: string }
): Promise<void> {
  // 1. Recover stuck documents (dispatched for micro_batches but not processed)
  await recoverZombiesForPhase(context, {
    runId: input.runId,
    phase: "micro_batches",
  });

  // 2. Recover stuck batches (enqueued but not computed)
  const db = getSimulationDb(context);
  const now = new Date();
  
  // Timeout threshold: 15 minutes
  const timeoutMs = 15 * 60 * 1000;
  const cutoff = new Date(now.getTime() - timeoutMs).toISOString();

  // Find enqueued batches older than cutoff
  const zombies = await db
    .selectFrom("simulation_run_micro_batches")
    .select(["r2_key", "batch_index"])
    .where("run_id", "=", input.runId)
    .where("status", "=", "enqueued")
    .where("updated_at", "<", cutoff)
    .execute();

  if (zombies.length === 0) {
    return;
  }

  // Log the intervention
  await addSimulationRunEvent(context, {
    runId: input.runId,
    level: "warn",
    kind: "host.zombie_sweep",
    payload: { phase: "micro_batches", count: zombies.length },
  });

  // Mark them as failed
  for (const z of zombies) {
    await db
      .updateTable("simulation_run_micro_batches")
      .set({
        status: "failed",
        error_json: JSON.stringify({
          message:
            "Zombie Timeout: Batch stuck in 'enqueued' state for > 15m. Worker likely crashed or timed out.",
          phase: "micro_batches",
          code: "ZOMBIE_TIMEOUT",
        }),
        updated_at: now.toISOString(),
      } as any)
      .where("run_id", "=", input.runId)
      .where("r2_key", "=", z.r2_key)
      .where("batch_index", "=", z.batch_index)
      .execute();
  }
}
