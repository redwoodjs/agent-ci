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

  "005_add_oauth_tables": {
    async up(db) {
      return [
        await db.schema
          .createTable("oauth_tokens")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("user_id", "text", (col) => col.notNull().unique())
          .addColumn("access_token", "text", (col) => col.notNull())
          .addColumn("refresh_token", "text", (col) => col.notNull())
          .addColumn("expires_at", "text", (col) => col.notNull())
          .addColumn("scope", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),

        await db.schema
          .createTable("oauth_state")
          .addColumn("state", "text", (col) => col.primaryKey())
          .addColumn("code_verifier", "text", (col) => col.notNull())
          .addColumn("expires_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("oauth_tokens").execute();
      await db.schema.dropTable("oauth_state").execute();
    },
  },

  "006_add_lanes_table": {
    async up(db) {
      return [
        await db.schema
          .createTable("lanes")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("projectId", "text", (col) =>
            col.notNull().references("projects.id").onDelete("cascade")
          )
          .addColumn("name", "text", (col) => col.notNull())
          .addColumn("position", "integer", (col) => col.notNull())
          .addColumn("isDefault", "boolean", (col) =>
            col.notNull().defaultTo(false)
          )
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("lanes").execute();
    },
  },

  "007_add_lane_and_position_to_tasks": {
    async up(db) {
      return [
        await db.schema
          .alterTable("tasks")
          .addColumn("laneId", "text", (col) =>
            col.references("lanes.id").onDelete("restrict")
          )
          .execute(),
        await db.schema
          .alterTable("tasks")
          .addColumn("position", "integer", (col) => col.defaultTo(0))
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.alterTable("tasks").dropColumn("laneId").execute();
      await db.schema.alterTable("tasks").dropColumn("position").execute();
    },
  },

  "008_add_system_prompt_to_lanes": {
    async up(db) {
      return [
        await db.schema
          .alterTable("lanes")
          .addColumn("systemPrompt", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.alterTable("lanes").dropColumn("systemPrompt").execute();
    },
  },

  "009_add_better_auth_tables": {
    async up(db) {
      return [
        // Users table
        await db.schema
          .createTable("user")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("name", "text", (col) => col.notNull())
          .addColumn("email", "text", (col) => col.notNull().unique())
          .addColumn("emailVerified", "boolean", (col) =>
            col.notNull().defaultTo(false)
          )
          .addColumn("image", "text")
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),

        // Sessions table
        await db.schema
          .createTable("session")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("userId", "text", (col) =>
            col.notNull().references("user.id").onDelete("cascade")
          )
          .addColumn("expiresAt", "text", (col) => col.notNull())
          .addColumn("token", "text", (col) => col.notNull().unique())
          .addColumn("ipAddress", "text")
          .addColumn("userAgent", "text")
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),

        // Accounts table (for social logins)
        await db.schema
          .createTable("account")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("userId", "text", (col) =>
            col.notNull().references("user.id").onDelete("cascade")
          )
          .addColumn("accountId", "text", (col) => col.notNull())
          .addColumn("providerId", "text", (col) => col.notNull())
          .addColumn("accessToken", "text")
          .addColumn("refreshToken", "text")
          .addColumn("expiresAt", "text")
          .addColumn("scope", "text")
          .addColumn("password", "text")
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),

        // Verification tokens table
        await db.schema
          .createTable("verification")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("identifier", "text", (col) => col.notNull())
          .addColumn("value", "text", (col) => col.notNull())
          .addColumn("expiresAt", "text", (col) => col.notNull())
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("verification").execute();
      await db.schema.dropTable("account").execute();
      await db.schema.dropTable("session").execute();
      await db.schema.dropTable("user").execute();
    },
  },

  "010_add_task_chat_sessions": {
    async up(db) {
      return [
        await db.schema
          .createTable("task_chat_sessions")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("taskId", "text", (col) =>
            col.notNull().references("tasks.id").onDelete("cascade")
          )
          .addColumn("containerId", "text", (col) => col.notNull())
          .addColumn("processId", "text", (col) => col.notNull())
          .addColumn("createdAt", "text", (col) => col.notNull())
          .addColumn("updatedAt", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("task_chat_sessions").execute();
    },
  },
} satisfies Migrations;
