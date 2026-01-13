import { type Migrations } from "rwsdk/db";

export const simulationStateMigrations = {
  "001_initial_schema": {
    async up(db) {
      return [
        await db.schema
          .createTable("simulation_runs")
          .addColumn("run_id", "text", (col) => col.primaryKey())
          .addColumn("status", "text", (col) => col.notNull())
          .addColumn("current_phase", "text", (col) => col.notNull())
          .addColumn("started_at", "text", (col) => col.notNull())
          .addColumn("updated_at", "text", (col) => col.notNull())
          .addColumn("last_progress_at", "text")
          .addColumn("moment_graph_namespace", "text")
          .addColumn("moment_graph_namespace_prefix", "text")
          .addColumn("config_json", "text")
          .addColumn("last_error_json", "text")
          .execute(),
        await db.schema
          .createIndex("simulation_runs_status_idx")
          .on("simulation_runs")
          .column("status")
          .execute(),
        await db.schema
          .createTable("simulation_run_events")
          .addColumn("id", "text", (col) => col.primaryKey())
          .addColumn("run_id", "text", (col) =>
            col.references("simulation_runs.run_id").onDelete("cascade")
          )
          .addColumn("level", "text", (col) => col.notNull())
          .addColumn("kind", "text", (col) => col.notNull())
          .addColumn("payload_json", "text", (col) => col.notNull())
          .addColumn("created_at", "text", (col) => col.notNull())
          .execute(),
        await db.schema
          .createIndex("simulation_run_events_run_idx")
          .on("simulation_run_events")
          .columns(["run_id", "created_at"])
          .execute(),
      ];
    },
    async down(db) {
      await db.schema.dropTable("simulation_run_events").execute();
      await db.schema.dropTable("simulation_runs").execute();
    },
  },
} satisfies Migrations;

