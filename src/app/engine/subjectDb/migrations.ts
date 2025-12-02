import { type Migrations } from "rwsdk/db";

export const subjectMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("subjects")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("document_ids", "text", (col) => col.notNull())
          .addColumn("parent_id", "text")
          .addColumn("child_ids", "text")
          .addColumn("narrative", "text")
          .addColumn("access_weight", "real")
          .execute(),
        await db.schema
          .createIndex("subjects_parent_id_idx")
          .on("subjects")
          .column("parent_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("subjects").execute();
    },
  },
  "002_add_idempotency_key": {
    async up(db) {
      return [
        await db.schema
          .alterTable("subjects")
          .addColumn("idempotency_key", "text", (col) => col.unique())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("subjects")
        .dropColumn("idempotency_key")
        .execute();
    },
  },
} satisfies Migrations;
