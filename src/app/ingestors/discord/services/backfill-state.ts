import { env } from "cloudflare:workers";
import { type Database, createDb } from "rwsdk/db";
import { type backfillMigrations } from "../db/backfill-migrations";
import { type DiscordBackfillStateDO } from "../db/backfill-durableObject";
import type { BackfillStatus } from "./backfill-types";

type BackfillDatabase = Database<typeof backfillMigrations>;

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_BACKFILL_STATE: DurableObjectNamespace<DiscordBackfillStateDO>;
  }
}

export async function getBackfillState(
  guildChannelKey: string
): Promise<{
  status: BackfillStatus;
  messages_cursor: string | null;
  threads_cursor: string | null;
  error_message: string | null;
  error_details: string | null;
} | null> {
  const db = createDb<BackfillDatabase>(
    (env as any).DISCORD_BACKFILL_STATE as DurableObjectNamespace<DiscordBackfillStateDO>,
    guildChannelKey
  );

  const state = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("guild_channel_key", "=", guildChannelKey)
    .executeTakeFirst();

  if (!state) {
    return null;
  }

  return {
    status: state.status as BackfillStatus,
    messages_cursor: state.messages_cursor,
    threads_cursor: state.threads_cursor,
    error_message: state.error_message,
    error_details: state.error_details,
  };
}

export async function updateBackfillState(
  guildChannelKey: string,
  updates: {
    status?: BackfillStatus;
    messages_cursor?: string | null;
    threads_cursor?: string | null;
    error_message?: string | null;
    error_details?: string | null;
  }
): Promise<void> {
  const db = createDb<BackfillDatabase>(
    (env as any).DISCORD_BACKFILL_STATE as DurableObjectNamespace<DiscordBackfillStateDO>,
    guildChannelKey
  );

  const now = new Date().toISOString();

  const existing = await db
    .selectFrom("backfill_state")
    .selectAll()
    .where("guild_channel_key", "=", guildChannelKey)
    .executeTakeFirst();

  const updateValues: any = {
    ...updates,
    updated_at: now,
  };

  if (existing) {
    await db
      .updateTable("backfill_state")
      .set(updateValues)
      .where("guild_channel_key", "=", guildChannelKey)
      .execute();
  } else {
    await db
      .insertInto("backfill_state")
      .values({
        guild_channel_key: guildChannelKey,
        status: updates.status || "pending",
        messages_cursor: updates.messages_cursor ?? null,
        threads_cursor: updates.threads_cursor ?? null,
        error_message: updates.error_message ?? null,
        error_details: updates.error_details ?? null,
        created_at: now,
        updated_at: now,
      } as any)
      .execute();
  }
}


