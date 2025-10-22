import { type Migrations } from "rwsdk/db";
import { sql } from "kysely";

export const migrations = {
  "001_create_raw_discord_messages_table": {
    async up(db) {
      return [
        await db.schema
          .createTable("raw_discord_messages")
          .addColumn("message_id", "text", (col) => col.primaryKey())
          .addColumn("channel_id", "text", (col) => col.notNull())
          .addColumn("guild_id", "text")
          .addColumn("author_id", "text", (col) => col.notNull())
          .addColumn("content", "text", (col) => col.notNull())
          .addColumn("timestamp", "text", (col) => col.notNull())
          .addColumn("thread_id", "text")
          .addColumn("raw_data", "text", (col) => col.notNull())
          .addColumn("ingested_at", "text", (col) =>
            col.notNull().defaultTo(sql`current_timestamp`)
          )
          .addColumn("processed_state", "text", (col) =>
            col.notNull().defaultTo("unprocessed")
          )
          .execute(),
      ];
    },

    async down(db) {
      await db.schema.dropTable("raw_discord_messages").execute();
    },
  },
} satisfies Migrations;
