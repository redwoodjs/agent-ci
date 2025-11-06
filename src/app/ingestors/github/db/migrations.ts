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
  "002_add_prs_comments_releases": {
    async up(db) {
      return [
        await db.schema
          .createTable("pull_requests")
          .addColumn("github_id", "integer", (col) => col.primaryKey())
          .addColumn("number", "integer", (col) => col.notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("state", "text", (col) => col.notNull())
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("pull_request_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("pull_request_github_id", "integer", (col) =>
            col.notNull().references("pull_requests.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("comments")
          .addColumn("github_id", "integer", (col) => col.primaryKey())
          .addColumn("issue_id", "integer")
          .addColumn("pull_request_id", "integer")
          .addColumn("review_id", "integer")
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("comment_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("comment_github_id", "integer", (col) =>
            col.notNull().references("comments.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("releases")
          .addColumn("github_id", "integer", (col) => col.primaryKey())
          .addColumn("tag_name", "text", (col) => col.notNull())
          .addColumn("name", "text")
          .addColumn("state", "text", (col) => col.notNull())
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("release_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("release_github_id", "integer", (col) =>
            col.notNull().references("releases.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("release_versions").execute();
      await db.schema.dropTable("releases").execute();
      await db.schema.dropTable("comment_versions").execute();
      await db.schema.dropTable("comments").execute();
      await db.schema.dropTable("pull_request_versions").execute();
      await db.schema.dropTable("pull_requests").execute();
    },
  },
} satisfies Migrations;
