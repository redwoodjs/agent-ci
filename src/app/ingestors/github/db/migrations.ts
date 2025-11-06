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
  "003_add_projects": {
    async up(db) {
      return [
        await db.schema
          .createTable("projects")
          .addColumn("github_id", "text", (col) => col.primaryKey())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("body", "text")
          .addColumn("state", "text", (col) => col.notNull())
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("project_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("project_github_id", "text", (col) =>
            col.notNull().references("projects.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("project_items")
          .addColumn("github_id", "text", (col) => col.primaryKey())
          .addColumn("project_github_id", "text", (col) =>
            col.notNull().references("projects.github_id")
          )
          .addColumn("content_id", "integer", (col) => col.notNull())
          .addColumn("content_type", "text", (col) => col.notNull())
          .addColumn("state", "text", (col) => col.notNull())
          .addColumn("latest_version_id", "integer")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createTable("project_item_versions")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("project_item_github_id", "text", (col) =>
            col.notNull().references("project_items.github_id")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("project_item_versions").execute();
      await db.schema.dropTable("project_items").execute();
      await db.schema.dropTable("project_versions").execute();
      await db.schema.dropTable("projects").execute();
    },
  },
} satisfies Migrations;
