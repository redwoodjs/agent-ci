import { type Migrations } from "rwsdk/db";

export const backfillMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("backfill_state")
          .addColumn("guild_channel_key", "text", (col) => col.primaryKey())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("messages_cursor", "text")
          .addColumn("threads_cursor", "text")
          .addColumn("error_message", "text")
          .addColumn("error_details", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("backfill_state").execute();
    },
  },
} satisfies Migrations;


