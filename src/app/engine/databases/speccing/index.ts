import { type Database, createDb } from "rwsdk/db";
import { type speccingMigrations } from "./migrations";
import { SpeccingStateDO } from "./durableObject";

import { Override } from "@/app/shared/kyselyTypeOverrides";

export { SpeccingStateDO };

type RawDatabase = Database<typeof speccingMigrations>;

export interface SpeccingDatabase {
  speccing_sessions: Override<
    RawDatabase["speccing_sessions"],
    {
      priority_queue_json: string[];
      processed_ids_json: string[];
      moment_graph_namespace: string | null;
      revision_mode: "server" | "client";
    }
  >;
}

export function getSpeccingDb(env: Cloudflare.Env) {
  return createDb<SpeccingDatabase>(
    env.SPECCING_STATE_DO as DurableObjectNamespace<SpeccingStateDO>,
    "speccing-state-v1"
  );
}
