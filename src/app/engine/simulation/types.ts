import type { Database } from "rwsdk/db";
import type { simulationStateMigrations } from "./migrations";
import { Override } from "@/app/shared/kyselyTypeOverrides";

export type SimulationDatabase = Database<typeof simulationStateMigrations>;

export type SimulationRunStatus =
  | "running"
  | "busy_running"
  | "paused_on_error"
  | "paused_manual"
  | "completed";

export const simulationPhases = [
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
