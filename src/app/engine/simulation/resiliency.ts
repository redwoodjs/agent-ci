import { SimulationDbContext } from "./types";
import { getSimulationDb } from "./db";

export async function recoverZombiesForPhase(
  context: SimulationDbContext,
  input: { runId: string; phase: string; timeoutMs?: number }
): Promise<void> {
  const db = getSimulationDb(context);
  const timeoutMs = input.timeoutMs ?? 5 * 60 * 1000; // Default 5 minutes
  const fiveMinutesAgo = new Date(Date.now() - timeoutMs).toISOString();
  const phase = input.phase;

  // Find documents that were dispatched but not processed, and are older than the threshold
  const zombies = await db
    .selectFrom("simulation_run_documents")
    .select(["r2_key", "dispatched_phases_json", "processed_phases_json"])
    .where("run_id", "=", input.runId)
    .where("updated_at", "<", fiveMinutesAgo)
    .execute();

  function safeJson<T>(input: string | any[] | null | undefined): T[] {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) return parsed;
      } catch (e) {
        // Fallback or ignore
      }
    }
    return [];
  }

  for (const zombie of zombies) {
    const dispatched = safeJson<string>(zombie.dispatched_phases_json);
    const processed = safeJson<string>(zombie.processed_phases_json);

    if (dispatched.includes(phase) && !processed.includes(phase)) {
      console.log(`[resiliency] Recovering zombie document ${zombie.r2_key} for phase ${phase}`);
      const nextDispatched = dispatched.filter(p => p !== phase);
      
      await db
        .updateTable("simulation_run_documents")
        .set({
          dispatched_phases_json: nextDispatched as any,
          updated_at: new Date().toISOString(),
        })
        .where("run_id", "=", input.runId)
        .where("r2_key", "=", zombie.r2_key)
        .execute();
    }
  }
}
