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
} satisfies Migrations;

