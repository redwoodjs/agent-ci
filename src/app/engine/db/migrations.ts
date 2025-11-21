import { type Migrations } from "rwsdk/db";

export const indexingStateMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("indexing_state")
          .addColumn("r2_key", "text", (col) => col.primaryKey())
          .addColumn("etag", "text", (col) => col.notNull())
          .addColumn("indexed_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("indexing_state_etag_idx")
          .on("indexing_state")
          .column("etag")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("indexing_state").execute();
    },
  },
  "002_add_chunk_ids": {
    // context(justinvdm, 21 Nov 2025): This column is effectively deprecated.
    // We no longer read/write `chunk_ids` to manage vector deletion (see EngineIndexingStateDO comments).
    // It remains in the schema to avoid migration churn.
    async up(db) {
      return [
        await db.schema
          .alterTable("indexing_state")
          .addColumn("chunk_ids", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("indexing_state")
        .dropColumn("chunk_ids")
        .execute();
    },
  },
} satisfies Migrations;
