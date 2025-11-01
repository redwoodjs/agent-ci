import { env } from "cloudflare:workers";
import { type Database, createDb, SqliteDurableObject } from "rwsdk/db";

import { migrations } from "./migrations";

export class RawDiscordDatabase extends SqliteDurableObject {
  migrations = migrations;
}

export const rawDiscordDb = createDb<Database<typeof migrations>>(
  env.RAW_DISCORD_DATABASE,
  "raw-discord"
);
