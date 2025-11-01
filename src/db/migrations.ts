import { type Migrations } from "rwsdk/db";
import { sql } from "rwsdk/db";

export const migrations = {
  "001_add_better_auth_tables": {
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

  "002_add_sources_table": {
    async up(db) {
      return [
        await db.schema
          .createTable("sources")
          .addColumn("id", "integer", (col) => col.primaryKey().autoIncrement())
          .addColumn("type", "text", (col) => col.notNull())
          .addColumn("name", "text", (col) => col.notNull())
          .addColumn("url", "text")
          .addColumn("description", "text", (col) => col.notNull())
          .addColumn("bucket", "text", (col) =>
            col.notNull().defaultTo("default")
          )
          .addColumn("createdAt", "text", (col) =>
            col.notNull().defaultTo(
              // @ts-expect-error - Kysely doesn't export DefaultValueExpression type
              sql`current_timestamp`
            )
          )
          .addColumn("updatedAt", "text", (col) =>
            col.notNull().defaultTo(
              // @ts-expect-error - Kysely doesn't export DefaultValueExpression type
              sql`current_timestamp`
            )
          )
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("sources").execute();
    },
  },
} satisfies Migrations;
