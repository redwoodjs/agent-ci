import { SqliteDurableObject } from "rwsdk/db";
import { indexingStateMigrations } from "./migrations";

export class EngineIndexingStateDO extends SqliteDurableObject {
  migrations = indexingStateMigrations;
}

