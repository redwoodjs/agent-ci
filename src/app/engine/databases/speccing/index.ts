import { type Database, createDb } from "rwsdk/db";
import { type speccingMigrations } from "./migrations";
import { SpeccingStateDO } from "./durableObject";

export { SpeccingStateDO };

export type SpeccingDatabase = Database<typeof speccingMigrations>;

export function getSpeccingDb(env: Cloudflare.Env) {
  return createDb<SpeccingDatabase>(
    env.SPECCING_STATE_DO as DurableObjectNamespace<SpeccingStateDO>,
    "speccing-state-v1"
  );
}
