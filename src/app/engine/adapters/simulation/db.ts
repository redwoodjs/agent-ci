import { createDb, type Database } from "rwsdk/db";
import type { EngineSimulationStateDO } from "./durableObject";
import { simulationStateMigrations } from "./migrations";
import { qualifyName } from "../../momentGraphNamespace";
import { momentMigrations } from "../../databases/momentGraph/migrations";
import type { SimulationDbContext } from "./types";

export function getSimulationDb(context: SimulationDbContext) {
  return createDb<Database<typeof simulationStateMigrations>>(
    (context.env as any)
      .ENGINE_SIMULATION_STATE as DurableObjectNamespace<EngineSimulationStateDO>,
    qualifyName("engine-simulation-state", context.momentGraphNamespace)
  );
}

type MomentDatabase = Database<typeof momentMigrations>;

export function getMomentGraphDb(
  env: Cloudflare.Env,
  momentGraphNamespace: string | null
) {
  return createDb<MomentDatabase>(
    (env as any).MOMENT_GRAPH_DO as any,
    qualifyName("moment-graph-v2", momentGraphNamespace)
  );
}

