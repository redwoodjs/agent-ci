import { SqliteDurableObject } from "rwsdk/db";
import { speccingMigrations } from "./migrations";

export class SpeccingStateDO extends SqliteDurableObject {
  migrations = speccingMigrations;
}
