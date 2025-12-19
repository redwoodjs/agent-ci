export type BackfillStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "paused_on_error"
  | "paused";

export interface SchedulerJobMessage {
  type: "scheduler";
  repository_key: string;
  owner: string;
  repo: string;
  entity_type:
    | "issues"
    | "pull_requests"
    | "comments"
    | "releases"
    | "projects";
  cursor?: string;
  backfill_run_id?: string;
}

export interface ProcessorJobMessage {
  type: "processor";
  repository_key: string;
  owner: string;
  repo: string;
  entity_type:
    | "issue"
    | "pull_request"
    | "comment"
    | "release"
    | "project"
    | "project_item";
  entity_data: unknown;
  event_type: string;
  backfill_run_id?: string;
  moment_graph_namespace_prefix?: string | null;
}

export type QueueMessage = SchedulerJobMessage | ProcessorJobMessage;
