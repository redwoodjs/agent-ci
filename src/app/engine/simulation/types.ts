import type { Database } from "rwsdk/db";
import type { simulationStateMigrations } from "./migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";

// Inferred Database (Base)
type InferredDb = Database<typeof simulationStateMigrations>;

// Static versions of tables to ensure all columns (even those from alterTable) are present.
// JSON columns use string/null to support manual JSON.stringify on write.
export interface SimulationRunsTable {
  run_id: string;
  status: string;
  current_phase: string;
  started_at: string;
  updated_at: string;
  last_progress_at: string | null;
  moment_graph_namespace: string | null;
  moment_graph_namespace_prefix: string | null;
  config_json: string | null;
  last_error_json: string | null;
}

export interface SimulationRunDocumentsTable {
  run_id: string;
  r2_key: string;
  etag: string | null;
  document_hash: string | null;
  changed: number;
  error_json: string | null;
  processed_at: string;
  updated_at: string;
  dispatched_phases_json: string | null;
  processed_phases_json: string | null;
}

export interface SimulationRunEventsTable {
  id: string;
  run_id: string;
  level: string;
  kind: string;
  payload_json: string;
  created_at: string;
}

export type SimulationDatabase = Override<
  InferredDb,
  {
    simulation_runs: SimulationRunsTable;
    simulation_run_documents: SimulationRunDocumentsTable;
    simulation_run_events: SimulationRunEventsTable;
  }
>;

export type SimulationRunStatus =
  | "running"
  | "awaiting_documents"
  | "busy_running"
  | "paused_on_error"
  | "paused_manual"
  | "completed"
  | "settling"
  | "advance";

export const simulationPhases = [
  "r2_listing",
  "ingest_diff",
  "micro_batches",
  "macro_synthesis",
  "macro_classification",
  "materialize_moments",
  "deterministic_linking",
  "candidate_sets",
  "timeline_fit",
] as const;

export type SimulationPhase = (typeof simulationPhases)[number];

export type SimulationRunEventLevel = "debug" | "info" | "warn" | "error";

export type SimulationDbContext = {
  env: Cloudflare.Env;
  momentGraphNamespace: string | null;
  heartbeat?: () => Promise<void>;
};

// Concrete JSON structures
export interface SimulationRunConfig {
  r2List?: {
    targetPrefixes?: string[];
    limitPerPage?: number;
    maxPages?: number;
    currentPrefixIdx?: number;
    pagesProcessed?: number;
    prefixPagesProcessed?: number;
    cursor?: string;
  };
  r2Keys?: string[];
}

export interface SimulationRunEventPayload {
  runId?: string;
  phase?: string;
  phaseIdx?: number;
  status?: string;
  nextPhase?: string;
  prefix?: string;
  cursor?: string;
  error?: any;
  [key: string]: any;
}

// Row types for Selects (Auto-parsed by rwsdk/db)
type Db = SimulationDatabase;
export type SimulationRunRow = Override<
  Db["simulation_runs"],
  {
    status: SimulationRunStatus;
    config_json: SimulationRunConfig;
    last_error_json: { message: string; stack?: string } | null;
  }
>;

export type SimulationRunEventRow = Override<
  Db["simulation_run_events"],
  {
    level: SimulationRunEventLevel;
    payload_json: SimulationRunEventPayload;
  }
>;

export type SimulationRunDocumentRow = Override<
  Db["simulation_run_documents"],
  {
    error_json: { message: string; stack?: string } | null;
    dispatched_phases_json: string[] | null;
    processed_phases_json: string[] | null;
  }
>;

export type SimulationRunR2BatchRow = Override<
  Db["simulation_run_r2_batches"],
  {
    keys_json: string[];
  }
>;

export type SimulationRunArtifactRow = Override<
  Db["simulation_run_artifacts"],
  {
    input_json: any;
    output_json: any;
  }
>;
export type SimulationQueueMessage =
  | {
      jobType: "simulation-advance";
      runId: string;
    }
  | {
      jobType: "simulation-document";
      runId: string;
      phase: SimulationPhase;
      r2Key: string;
    }
  | {
      jobType: "simulation-batch";
      runId: string;
      phase: "micro_batches";
      r2Key: string;
      batchIndex: number;
    };
