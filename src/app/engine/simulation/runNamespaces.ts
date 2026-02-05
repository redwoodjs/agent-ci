import { SimulationDbContext } from "./types";
import { getSimulationDb } from "./db";

export async function registerParticipatingNamespace(
  context: SimulationDbContext,
  input: {
    runId: string;
    namespace: string | null;
  }
): Promise<void> {
  const db = getSimulationDb(context);
  // Column "namespace" is NOT NULL in migration 012.
  // We normalize null to an empty string.
  const ns = input.namespace === null ? "" : input.namespace;

  try {
    await db
      .insertInto("simulation_run_participating_namespaces")
      .values({
        run_id: input.runId,
        namespace: ns,
        created_at: new Date().toISOString(),
      })
      .onConflict((oc) => oc.columns(["run_id", "namespace"]).doNothing())
      .execute();
  } catch (e) {
    // Already exists or other error
    console.warn(`[simulation:registerParticipatingNamespace] Failed to register ${ns} for run ${input.runId}:`, e);
  }
}
