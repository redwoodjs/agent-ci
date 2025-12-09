import { SqliteDurableObject } from "rwsdk/db";
import { momentMigrations } from "./migrations";

export class MomentGraphDO extends SqliteDurableObject {
  migrations = momentMigrations;
}
