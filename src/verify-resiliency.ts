
import { getSimulationDb } from "./app/engine/simulation/db";
import { recoverZombiesTimelineFit } from "./app/pipelines/timeline_fit/engine/simulation/runner";
import { recoverZombiesForPhase } from "./app/engine/simulation/resiliency";

async function verifyResiliency(env: any) {
  const db = getSimulationDb({ env, momentGraphNamespace: null });
  const runId = "verify-resiliency-" + Date.now();
  const r2Key = "test-doc-" + Date.now();
  const phase = "timeline_fit";

  console.log(`[verify] Creating test run ${runId}...`);
  await db.insertInto("simulation_runs").values({
    run_id: runId,
    status: "running",
    config_json: JSON.stringify({}),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).execute();

  console.log(`[verify] Inserting stuck document...`);
  // Insert a document that looks like it's stuck (dispatched but not processed, older than 5 mins)
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await db.insertInto("simulation_run_documents").values({
    run_id: runId,
    r2_key: r2Key,
    changed: 1,
    processed_at: "pending",
    updated_at: tenMinutesAgo,
    dispatched_phases_json: JSON.stringify([phase]), // Intentionally stored as string to match old behavior if any, but properly it should be array if we fixed types. checking if our new types work.
    // Wait, we updated types to string[] | null, so kysely matches.
    // But let's pass it as array.
    processed_phases_json: JSON.stringify([]),
  } as any).execute();
  
  // NOTE: We need to make sure we are inserting as the DB expects. 
  // If we fixed the types, we should pass arrays.
  // Let's re-insert with arrays if the above fails or just update.
  await db.updateTable("simulation_run_documents")
      .set({
          dispatched_phases_json: [phase] as any,
          processed_phases_json: [] as any
      })
      .where("run_id", "=", runId)
      .where("r2_key", "=", r2Key)
      .execute();

  console.log(`[verify] Verifying stuck state...`);
  const stuckInfo = await db.selectFrom("simulation_run_documents")
    .select(["dispatched_phases_json", "processed_phases_json"])
    .where("run_id", "=", runId)
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();
    
  console.log("Stuck State:", stuckInfo);

  console.log(`[verify] Running recoverZombies...`);
  await recoverZombiesForPhase({ env, momentGraphNamespace: null }, { runId, phase });

  console.log(`[verify] Checking result...`);
  const result = await db.selectFrom("simulation_run_documents")
    .select(["dispatched_phases_json", "processed_phases_json"])
    .where("run_id", "=", runId)
    .where("r2_key", "=", r2Key)
    .executeTakeFirst();

  console.log("Recovered State:", result);

  const dispatched = (result?.dispatched_phases_json as any) || [];
  if (!dispatched.includes(phase)) {
      console.log("SUCCESS: Document was reset (phase removed from dispatched list).");
  } else {
      console.error("FAILURE: Document was NOT reset.");
  }
}

export default {
  async fetch(request: Request, env: any) {
    try {
        await verifyResiliency(env);
        return new Response("Verification complete, check logs.");
    } catch (e: any) {
        return new Response(e.stack, { status: 500 });
    }
  }
};
