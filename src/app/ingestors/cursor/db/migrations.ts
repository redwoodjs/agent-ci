import { type Migrations } from "rwsdk/db";

export const migrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("events")
          .addColumn("id", "integer", (col) => col.primaryKey())
          .addColumn("event_data", "text", (col) => col.notNull())
          .addColumn("timestamp", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("events").ifExists().execute();
    },
  },
} satisfies Migrations;
