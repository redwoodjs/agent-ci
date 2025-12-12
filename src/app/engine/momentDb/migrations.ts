import { type Migrations } from "rwsdk/db";

export const momentMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("moments")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("summary", "text", (col) => col.notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("parent_id", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("author", "text", (col) => col.notNull())
          .addColumn("source_metadata", "text")
          .execute(),
        await db.schema
          .createIndex("moments_parent_id_idx")
          .on("moments")
          .column("parent_id")
          .execute(),
        await db.schema
          .createIndex("moments_document_id_idx")
          .on("moments")
          .column("document_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("moments").execute();
    },
  },
  "002_add_document_structure_hash": {
    async up(db) {
      return [
        await db.schema
          .createTable("document_structure_hash")
          .addColumn("document_id", "text", (col) => col.primaryKey())
          .addColumn("structure_hash", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("document_structure_hash").execute();
    },
  },
  "003_add_micro_moments": {
    async up(db) {
      return [
        await db.schema
          .createTable("micro_moments")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("path", "text", (col) => col.notNull())
          .addColumn("content", "text", (col) => col.notNull())
          .addColumn("summary", "text")
          .addColumn("embedding", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("author", "text", (col) => col.notNull())
          .addColumn("source_metadata", "text")
          .execute(),
        await db.schema
          .createIndex("micro_moments_document_path_idx")
          .on("micro_moments")
          .columns(["document_id", "path"])
          .unique()
          .execute(),
        await db.schema
          .createIndex("micro_moments_document_id_idx")
          .on("micro_moments")
          .column("document_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("micro_moments").execute();
    },
  },
} satisfies Migrations;
