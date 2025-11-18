import { SqliteDurableObject } from "rwsdk/db";
import { backfillMigrations } from "./backfill-migrations";

export class DiscordBackfillStateDO extends SqliteDurableObject {
  migrations = backfillMigrations;
}


