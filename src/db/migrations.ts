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
      await db.schema.dropTable("tasks").execute();
    },
  },

  "003_add_process_command_and_update_boot_commands": {
    async up(db) {
      return [
        await db.schema
          .alterTable("projects")
          .addColumn("processCommand", "text")
          .execute(),
        await db.schema
          .alterTable("projects")
          .dropColumn("runOnBoot")
          .execute(),
        await db.schema
          .alterTable("projects")
          .addColumn("runOnBoot", "text", (col) =>
            col.notNull().defaultTo("[]")
          )
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("projects")
        .dropColumn("processCommand")
        .execute();
      await db.schema.alterTable("projects").dropColumn("runOnBoot").execute();
      await db.schema
        .alterTable("projects")
        .addColumn("runOnBoot", "text", (col) => col.notNull())
        .execute();
    },
  },

  "004_add_exposed_ports": {
    async up(db) {
      return [
        await db.schema
          .alterTable("projects")
          .addColumn("exposePorts", "text", (col) =>
            col.notNull().defaultTo("[]")
          )
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("projects")
        .dropColumn("exposePorts")
        .execute();
    },
  },
} satisfies Migrations;
