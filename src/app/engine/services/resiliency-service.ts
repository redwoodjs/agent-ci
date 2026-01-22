import { getSimulationDb } from "../simulation/db";

export async function processResiliencyHeartbeat(
  env: Cloudflare.Env
): Promise<void> {
  const db = getSimulationDb({ env, momentGraphNamespace: null });

  // Find active runs that might need a tick
  const activeRuns = await db
    .selectFrom("simulation_runs")
    .select("run_id")
    .where("status", "in", ["running", "busy_running", "awaiting_documents"])
    .execute();

  if (activeRuns.length === 0) {
    console.log("[resiliency] No active simulation runs to poke.");
    return;
  }

  console.log(
    `[resiliency] Resetting heartbeat for ${activeRuns.length} active runs`
  );

  const queue = (env as any).ENGINE_INDEXING_QUEUE;
  if (!queue) {
    console.warn("[resiliency] ENGINE_INDEXING_QUEUE not found, cannot send heartbeat");
    return;
  }

  for (const run of activeRuns) {
    // Send a simulation-advance message to ensure the runner wakes up
    // and checks for both progress AND zombies.
    await queue.send({
      jobType: "simulation-advance",
      runId: run.run_id,
    });
  }
}
