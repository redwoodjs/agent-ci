import { type Migrations } from "rwsdk/db";

export const migrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("projects")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("name", "text", (col) => col.notNull())
          .addColumn("description", "text", (col) => col.notNull())
          .addColumn("runOnBoot", "text", (col) => col.notNull())
          .addColumn("repository", "text")
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },

    async down(db) {
      await db.schema.dropTable("projects").execute();
    },
  },

  "002_add_tasks_table": {
    async up(db) {
      return [
        await db.schema
          .createTable("tasks")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("projectId", "text", (col) =>
            col.notNull().references("projects.id").onDelete("cascade")
          )
          .addColumn("containerId", "text", (col) => col.notNull())
          .addColumn("name", "text", (col) => col.notNull())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },

    async down(db) {
      await db.schema.dropTable("projects").execute();
      await db.schema.dropTable("tasks").execute();
    },
  },
} satisfies Migrations;
