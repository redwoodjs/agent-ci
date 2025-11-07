import { SqliteDurableObject } from "rwsdk/db";
import { backfillMigrations } from "./backfill-migrations";

export class GitHubBackfillStateDO extends SqliteDurableObject {
  migrations = backfillMigrations;
}

