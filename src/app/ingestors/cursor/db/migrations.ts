import { type Migrations } from "rwsdk/db";

export const migrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("events")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("event_data", "text", (col) => col.notNull())
          .addColumn("timestamp", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("events").ifExists().execute();
    },
  },
  "002_add_exchange_cache": {
    async up(db) {
      return [
        await db.schema
          .createTable("exchange_cache")
          .addColumn("generation_id", "text", (col) => col.primaryKey())
          .addColumn("summary", "text", (col) => col.notNull())
          .addColumn("embedding", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("exchange_cache").ifExists().execute();
    },
  },
  "003_exchange_cache_json_blob": {
    async up(db) {
      return [
        await db.schema.dropTable("exchange_cache").ifExists().execute(),
        await db.schema
          .createTable("exchange_cache")
          .addColumn("document_id", "text", (col) => col.primaryKey())
          .addColumn("cache_json", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("exchange_cache").ifExists().execute();
      await db.schema
        .createTable("exchange_cache")
        .addColumn("generation_id", "text", (col) => col.primaryKey())
        .addColumn("summary", "text", (col) => col.notNull())
        .addColumn("embedding", "text", (col) => col.notNull())
        .addColumn("created_at", "text", (col) => col.notNull())
        .execute();
    },
  },
} satisfies Migrations;
