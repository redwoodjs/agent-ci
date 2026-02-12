import { type Migrations } from "rwsdk/db";

export const speccingMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("speccing_sessions")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("subject_id", "text", (col) => col.notNull())
          .addColumn("priority_queue_json", "text", (col) => col.notNull())
          .addColumn("processed_ids_json", "text", (col) => col.notNull())
          .addColumn("working_spec", "text", (col) => col.notNull())
          .addColumn("replay_timestamp", "text", (col) => col.notNull())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("speccing_sessions_subject_id_idx")
          .on("speccing_sessions")
          .column("subject_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("speccing_sessions").execute();
    },
  },
  "002_add_namespace_context": {
    async up(db) {
      return [
        await db.schema
          .alterTable("speccing_sessions")
          .addColumn("moment_graph_namespace", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("speccing_sessions")
        .dropColumn("moment_graph_namespace")
        .execute();
    },
  },
  "003_add_revision_mode": {
    async up(db) {
      return [
        await db.schema
          .alterTable("speccing_sessions")
          .addColumn("revision_mode", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("speccing_sessions")
        .dropColumn("revision_mode")
        .execute();
    },
  },
} satisfies Migrations;
