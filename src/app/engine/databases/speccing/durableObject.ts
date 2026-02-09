import { SqliteDurableObject } from "rwsdk/db";
import { speccingMigrations } from "./migrations";

export class SpeccingStateDO extends SqliteDurableObject {
  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env, speccingMigrations);
  }
}
