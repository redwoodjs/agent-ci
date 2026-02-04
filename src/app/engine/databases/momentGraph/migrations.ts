import { type Migrations } from "rwsdk/db";

export const momentMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("moments")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("summary", "text", (col) => col.notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("parent_id", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("author", "text", (col) => col.notNull())
          .addColumn("source_metadata", "text")
          .execute(),
        await db.schema
          .createIndex("moments_parent_id_idx")
          .on("moments")
          .column("parent_id")
          .execute(),
        await db.schema
          .createIndex("moments_document_id_idx")
          .on("moments")
          .column("document_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("moments").execute();
    },
  },
  "002_add_document_structure_hash": {
    async up(db) {
      return [
        await db.schema
          .createTable("document_structure_hash")
          .addColumn("document_id", "text", (col) => col.primaryKey())
          .addColumn("structure_hash", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("document_structure_hash").execute();
    },
  },
  "003_add_micro_moments": {
    async up(db) {
      return [
        await db.schema
          .createTable("micro_moments")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("path", "text", (col) => col.notNull())
          .addColumn("content", "text", (col) => col.notNull())
          .addColumn("summary", "text")
          .addColumn("embedding", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("author", "text", (col) => col.notNull())
          .addColumn("source_metadata", "text")
          .execute(),
        await db.schema
          .createIndex("micro_moments_document_path_idx")
          .on("micro_moments")
          .columns(["document_id", "path"])
          .unique()
          .execute(),
        await db.schema
          .createIndex("micro_moments_document_id_idx")
          .on("micro_moments")
          .column("document_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("micro_moments").execute();
    },
  },
  "004_add_macro_moment_membership": {
    async up(db) {
      return [
        await db.schema
          .alterTable("moments")
          .addColumn("micro_paths_json", "text")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("micro_paths_hash", "text")
          .execute(),
        await db.schema
          .createIndex("moments_document_micro_paths_hash_idx")
          .on("moments")
          .columns(["document_id", "micro_paths_hash"])
          .unique()
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .dropIndex("moments_document_micro_paths_hash_idx")
        .execute();
      await db.schema
        .alterTable("moments")
        .dropColumn("micro_paths_hash")
        .execute();
      await db.schema
        .alterTable("moments")
        .dropColumn("micro_paths_json")
        .execute();
    },
  },
  "005_add_moment_importance": {
    async up(db) {
      return [
        await db.schema
          .alterTable("moments")
          .addColumn("importance", "real")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.alterTable("moments").dropColumn("importance").execute();
    },
  },
  "006_add_micro_moment_batches": {
    async up(db) {
      return [
        await db.schema
          .createTable("micro_moment_batches")
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("batch_hash", "text", (col) => col.notNull())
          .addColumn("items_json", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("micro_moment_batches_document_batch_idx")
          .on("micro_moment_batches")
          .columns(["document_id", "batch_hash"])
          .unique()
          .execute(),
        await db.schema
          .createIndex("micro_moment_batches_document_id_idx")
          .on("micro_moment_batches")
          .column("document_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("micro_moment_batches").execute();
    },
  },
  "007_add_moment_link_audit_log": {
    async up(db) {
      return [
        await db.schema
          .alterTable("moments")
          .addColumn("link_audit_log", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("moments")
        .dropColumn("link_audit_log")
        .execute();
    },
  },
  "008_add_document_audit_logs": {
    async up(db) {
      return [
        await db.schema
          .createTable("document_audit_logs")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("kind", "text", (col) => col.notNull())
          .addColumn("payload_json", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("document_audit_logs_document_id_idx")
          .on("document_audit_logs")
          .column("document_id")
          .execute(),
        await db.schema
          .createIndex("document_audit_logs_document_kind_created_idx")
          .on("document_audit_logs")
          .columns(["document_id", "kind", "created_at"])
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("document_audit_logs").execute();
    },
  },
  "009_add_subject_markers": {
    async up(db) {
      return [
        await db.schema
          .alterTable("moments")
          .addColumn("is_subject", "integer")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("subject_kind", "text")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("subject_reason", "text")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("subject_evidence_json", "text")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("moment_kind", "text")
          .execute(),
        await db.schema
          .alterTable("moments")
          .addColumn("moment_evidence_json", "text")
          .execute(),
        await db.schema
          .createIndex("moments_is_subject_idx")
          .on("moments")
          .column("is_subject")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropIndex("moments_is_subject_idx").execute();
      await db.schema.alterTable("moments").dropColumn("moment_evidence_json").execute();
      await db.schema.alterTable("moments").dropColumn("moment_kind").execute();
      await db.schema.alterTable("moments").dropColumn("subject_evidence_json").execute();
      await db.schema.alterTable("moments").dropColumn("subject_reason").execute();
      await db.schema.alterTable("moments").dropColumn("subject_kind").execute();
      await db.schema.alterTable("moments").dropColumn("is_subject").execute();
    },
  },
  "010_add_moment_anchors": {
    async up(db) {
      return [
        await db.schema
          .createTable("moment_anchors")
          .addColumn("moment_id", "text", (col) =>
            col.references("moments.id").onDelete("cascade")
          )
          .addColumn("anchor", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("moment_anchors_anchor_moment_idx")
          .on("moment_anchors")
          .columns(["anchor", "moment_id"])
          .execute(),
        await db.schema
          .createIndex("moment_anchors_moment_id_idx")
          .on("moment_anchors")
          .column("moment_id")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("moment_anchors").execute();
    },
  },
} satisfies Migrations;
