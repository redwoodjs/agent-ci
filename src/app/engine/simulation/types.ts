import type { Database } from "rwsdk/db";
import type { simulationStateMigrations } from "./migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";

// We use Override to manually patch the type because Kysely's inference
// might miss columns added in try/catch blocks in migrations 010/011.
type SimulationRunDocumentsTable = {
  run_id: string;
  r2_key: string;
  etag: string | null;
  document_hash: string | null;
  changed: number;
  error_json: any;
  processed_at: string;
  updated_at: string;
  dispatched_phases_json: string | null;
  processed_phases_json: string | null;
};

export type SimulationDatabase = Override<
  Database<typeof simulationStateMigrations>,
  {
    simulation_run_documents: SimulationRunDocumentsTable;
    simulation_run_r2_batches: {
        run_id: string;
        batch_index: number;
        keys_json: string;
        processed: number;
        created_at: string;
        updated_at: string;
    };
  }
>;

export type SimulationRunStatus =
  | "running"
  | "awaiting_documents"
  | "busy_running"
  | "paused_on_error"
  | "paused_manual"
  | "completed";

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
};

type SimulationRunInput = SimulationDatabase["simulation_runs"];
export type SimulationRunRow = Override<
  SimulationRunInput,
  {
    config_json: any;
    last_error_json: any;
  }
>;

type SimulationRunEventInput = SimulationDatabase["simulation_run_events"];
export type SimulationRunEventRow = Override<
  SimulationRunEventInput,
  {
    payload_json: any;
  }
>;

type SimulationRunDocumentInput = SimulationDatabase["simulation_run_documents"];
export type SimulationRunDocumentRow = Override<
  SimulationRunDocumentInput,
  {
    error_json: any;
    dispatched_phases_json: string[] | null;
    processed_phases_json: string[] | null;
  }
>;

type SimulationRunMicroBatchInput =
  SimulationDatabase["simulation_run_micro_batches"];
export type SimulationRunMicroBatchRow = Override<
  SimulationRunMicroBatchInput,
  {
    error_json: any;
  }
>;

type SimulationMicroBatchCacheInput =
  SimulationDatabase["simulation_micro_batch_cache"];
export type SimulationMicroBatchCacheRow = Override<
  SimulationMicroBatchCacheInput,
  {
    micro_items_json: any;
  }
>;

type SimulationRunMacroOutputInput =
  SimulationDatabase["simulation_run_macro_outputs"];
export type SimulationRunMacroOutputRow = Override<
  SimulationRunMacroOutputInput,
  {
    streams_json: any;
    audit_json: any;
    gating_json: any;
    anchors_json: any;
  }
>;

type SimulationRunMacroClassifiedOutputInput =
  SimulationDatabase["simulation_run_macro_classified_outputs"];
export type SimulationRunMacroClassifiedOutputRow = Override<
  SimulationRunMacroClassifiedOutputInput,
  {
    streams_json: any;
    gating_json: any;
    classification_json: any;
  }
>;

type SimulationRunMaterializedMomentInput =
  SimulationDatabase["simulation_run_materialized_moments"];
export type SimulationRunMaterializedMomentRow = Override<
  SimulationRunMaterializedMomentInput,
  {}
>;

type SimulationRunLinkDecisionInput =
  SimulationDatabase["simulation_run_link_decisions"];
export type SimulationRunLinkDecisionRow = Override<
  SimulationRunLinkDecisionInput,
  {
    evidence_json: any;
  }
>;

type SimulationRunCandidateSetInput =
  SimulationDatabase["simulation_run_candidate_sets"];
export type SimulationRunCandidateSetRow = Override<
  SimulationRunCandidateSetInput,
  {
    candidates_json: any;
    stats_json: any;
  }
>;

type SimulationRunTimelineFitDecisionInput =
  SimulationDatabase["simulation_run_timeline_fit_decisions"];
export type SimulationRunTimelineFitDecisionRow = Override<
  SimulationRunTimelineFitDecisionInput,
  {
    decisions_json: any;
    stats_json: any;
  }
>;
type SimulationRunR2BatchInput = SimulationDatabase["simulation_run_r2_batches"];
export type SimulationRunR2BatchRow = Override<
  SimulationRunR2BatchInput,
  {
    keys_json: string[];
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
