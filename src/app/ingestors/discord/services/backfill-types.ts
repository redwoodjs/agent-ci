export type BackfillStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "paused_on_error"
  | "paused";

export interface SchedulerJobMessage {
  type: "scheduler";
  guild_channel_key: string;
  guildID: string;
  channelID: string;
  entity_type: "messages" | "threads";
  cursor?: string;
  backfill_run_id?: string;
}

export interface ProcessorJobMessage {
  type: "processor";
  guild_channel_key: string;
  guildID: string;
  channelID: string;
  entity_type: "channel" | "thread";
  entity_id?: string;
  event_type: string;
  backfill_run_id?: string;
  moment_graph_namespace_prefix?: string | null;
}

export interface GatewayEventMessage {
  type: "gateway_event";
  op: number;
  t: string | null;
  s: number | null;
  d: any;
}

export type QueueMessage =
  | SchedulerJobMessage
  | ProcessorJobMessage
  | GatewayEventMessage;
