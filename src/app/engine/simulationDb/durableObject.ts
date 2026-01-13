import { SqliteDurableObject } from "rwsdk/db";
import { simulationStateMigrations } from "./migrations";

export class EngineSimulationStateDO extends SqliteDurableObject {
  migrations = simulationStateMigrations;
}

