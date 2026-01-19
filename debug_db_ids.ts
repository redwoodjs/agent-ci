
import { getSimulationDb } from "./src/app/engine/simulation/db";

async function main() {
    const runId = "fde54e8d-76fc-4cb3-8693-debd8b6ab5cf"; // From logs
    const r2Key = "github/redwoodjs/sdk/issues/414/latest.json"; // From user report
    // const r2Key = "noop-cursor/conversations/d0ae0f97-62e4-4f53-a5f9-dc6aa7a013bd/latest.json"; 

    const db = getSimulationDb({
        env: process.env, 
        momentGraphNamespace: "local-2026-01-19-20-24-brisk-heron"
    } as any);

    console.log("--- Materialized Moments ---");
    const mat = await db.selectFrom("simulation_run_materialized_moments")
        .selectAll()
        .where("run_id", "=", runId)
        .where("r2_key", "=", r2Key)
        .execute();
    console.log(mat);

    console.log("\n--- Candidate Sets ---");
    const cand = await db.selectFrom("simulation_run_candidate_sets")
        .selectAll()
        .where("run_id", "=", runId)
        .where("r2_key", "=", r2Key)
        .execute();
    console.log(cand);
    
    console.log("\n--- Timeline Fit ---");
    const fit = await db.selectFrom("simulation_run_timeline_fit_decisions")
        .selectAll()
        .where("run_id", "=", runId)
        .where("r2_key", "=", r2Key)
        .execute();
    console.log(fit);
}

main();
