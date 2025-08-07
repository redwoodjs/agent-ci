import { type Migrations } from "rwsdk/db";

export const migrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("projects")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("repository", "text", (col) => col.notNull().unique())
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },

    async down(db) {
      await db.schema.dropTable("secrets").execute();
      await db.schema.dropTable("projects").execute();
    },
  },
} satisfies Migrations;
