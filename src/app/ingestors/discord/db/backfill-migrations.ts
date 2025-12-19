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
  "002_add_run_tracking": {
    async up(db) {
      return [
        await db.schema
          .alterTable("backfill_state")
          .addColumn("current_run_id", "text")
          .addColumn("moment_graph_namespace_prefix", "text")
          .addColumn("enqueued_count", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .addColumn("processed_count", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .addColumn("enqueue_completed", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .addColumn("processed_completed", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .addColumn("processed_completed_at", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("backfill_state")
        .dropColumn("current_run_id")
        .dropColumn("moment_graph_namespace_prefix")
        .dropColumn("enqueued_count")
        .dropColumn("processed_count")
        .dropColumn("enqueue_completed")
        .dropColumn("processed_completed")
        .dropColumn("processed_completed_at")
        .execute();
    },
  },
} satisfies Migrations;
