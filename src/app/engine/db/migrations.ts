import { type Migrations } from "rwsdk/db";

export const indexingStateMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("indexing_state")
          .addColumn("r2_key", "text", (col) => col.primaryKey())
          .addColumn("etag", "text", (col) => col.notNull())
          .addColumn("indexed_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("indexing_state_etag_idx")
          .on("indexing_state")
          .column("etag")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("indexing_state").execute();
    },
  },
  "002_add_chunk_ids": {
    // context(justinvdm, 21 Nov 2025): This column is DEPRECATED and UNUSED.
    // We no longer read/write `chunk_ids` to manage vector deletion.
    // However, the `indexing_state` table itself remains CRITICAL for ETag caching (see EngineIndexingStateDO).
    // This column remains in the schema only to avoid migration churn.
    async up(db) {
      return [
        await db.schema
          .alterTable("indexing_state")
          .addColumn("chunk_ids", "text")
          .execute(),
      ];
    },
    async down(db) {
      await db.schema
        .alterTable("indexing_state")
        .dropColumn("chunk_ids")
        .execute();
    },
  },
  "003_add_processed_chunks_table": {
    async up(db) {
      return [
        await db.schema
          .createTable("processed_chunks")
          .addColumn("r2_key", "text", (col) =>
            col.references("indexing_state.r2_key")
          )
          .addColumn("chunk_hash", "text", (col) => col.notNull())
          .addPrimaryKeyConstraint("processed_chunks_pk", [
            "r2_key",
            "chunk_hash",
          ])
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("processed_chunks").execute();
    },
  },
  "004_refactor_processed_chunks_to_json": {
    async up(db) {
      return [
        // Step 1: Add the new JSON column to the indexing_state table.
        await db.schema
          .alterTable("indexing_state")
          .addColumn("processed_chunk_hashes_json", "text")
          .execute(),

        // Step 2: Drop the old processed_chunks table.
        await db.schema.dropTable("processed_chunks").execute(),
      ];
    },
    async down(db) {
      // Recreate the old processed_chunks table on rollback.
      await db.schema
        .createTable("processed_chunks")
        .addColumn("r2_key", "text", (col) =>
          col.references("indexing_state.r2_key")
        )
        .addColumn("chunk_hash", "text", (col) => col.notNull())
        .addPrimaryKeyConstraint("processed_chunks_pk", [
          "r2_key",
          "chunk_hash",
        ])
        .execute();

      // Drop the new JSON column.
      await db.schema
        .alterTable("indexing_state")
        .dropColumn("processed_chunk_hashes_json")
        .execute();
    },
  },
  "005_add_moment_replay_tables": {
    async up(db) {
      return [
        await db.schema
          .createTable("moment_replay_runs")
          .addColumn("run_id", "text", (col) => col.primaryKey())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("started_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addColumn("moment_graph_namespace", "text")
          .addColumn("moment_graph_namespace_prefix", "text")
          .addColumn("expected_documents", "integer", (col) => col.notNull())
          .addColumn("collected_documents", "integer", (col) => col.notNull())
          .addColumn("replay_enqueued", "integer", (col) => col.notNull())
          .addColumn("replayed_items", "integer", (col) => col.notNull())
          .addColumn("replay_cursor_json", "text")
          .execute(),
        await db.schema
          .createIndex("moment_replay_runs_status_idx")
          .on("moment_replay_runs")
          .column("status")
          .execute(),
        await db.schema
          .createTable("moment_replay_items")
          .addColumn("run_id", "text", (col) =>
            col.references("moment_replay_runs.run_id").onDelete("cascade")
          )
          .addColumn("item_id", "text", (col) => col.notNull())
          .addColumn("effective_namespace", "text", (col) => col.notNull())
          .addColumn("order_ms", "integer", (col) => col.notNull())
          .addColumn("payload_json", "text", (col) => col.notNull())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addPrimaryKeyConstraint("moment_replay_items_pk", [
            "run_id",
            "item_id",
          ])
          .execute(),
        await db.schema
          .createIndex("moment_replay_items_order_idx")
          .on("moment_replay_items")
          .columns([
            "run_id",
            "status",
            "effective_namespace",
            "order_ms",
            "item_id",
          ])
          .execute(),
        await db.schema
          .createTable("moment_replay_stream_state")
          .addColumn("run_id", "text", (col) =>
            col.references("moment_replay_runs.run_id").onDelete("cascade")
          )
          .addColumn("effective_namespace", "text", (col) => col.notNull())
          .addColumn("document_id", "text", (col) => col.notNull())
          .addColumn("stream_id", "text", (col) => col.notNull())
          .addColumn("last_moment_id", "text")
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addPrimaryKeyConstraint("moment_replay_stream_state_pk", [
            "run_id",
            "effective_namespace",
            "document_id",
            "stream_id",
          ])
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("moment_replay_stream_state").execute();
      await db.schema.dropTable("moment_replay_items").execute();
      await db.schema.dropTable("moment_replay_runs").execute();
    },
  },
  "006_add_moment_replay_document_results": {
    async up(db) {
      return [
        await db.schema
          .alterTable("moment_replay_runs")
          .addColumn("processed_documents", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .execute(),
        await db.schema
          .alterTable("moment_replay_runs")
          .addColumn("succeeded_documents", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .execute(),
        await db.schema
          .alterTable("moment_replay_runs")
          .addColumn("failed_documents", "integer", (col) =>
            col.notNull().defaultTo(0)
          )
          .execute(),
        await db.schema
          .createTable("moment_replay_document_results")
          .addColumn("run_id", "text", (col) =>
            col.references("moment_replay_runs.run_id").onDelete("cascade")
          )
          .addColumn("r2_key", "text", (col) => col.notNull())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("error_json", "text")
          .addColumn("created_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addPrimaryKeyConstraint("moment_replay_document_results_pk", [
            "run_id",
            "r2_key",
          ])
          .execute(),
        await db.schema
          .createIndex("moment_replay_document_results_status_idx")
          .on("moment_replay_document_results")
          .columns(["run_id", "status"])
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("moment_replay_document_results").execute();
      await db.schema
        .alterTable("moment_replay_runs")
        .dropColumn("processed_documents")
        .dropColumn("succeeded_documents")
        .dropColumn("failed_documents")
        .execute();
    },
  },
} satisfies Migrations;
