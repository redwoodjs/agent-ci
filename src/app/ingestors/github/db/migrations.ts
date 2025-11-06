import { type Migrations } from "rwsdk/db";

export const migrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("issues")
          .addColumn("github_id", "integer", (col) => col.primaryKey())
          .addColumn("number", "integer", (col) => col.notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("state", "text", (col) => col.notNull())
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("issue_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("issue_github_id", "integer", (col) =>
            col.notNull().references("issues.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("issue_versions").execute();
      await db.schema.dropTable("issues").execute();
    },
  },
} satisfies Migrations;
