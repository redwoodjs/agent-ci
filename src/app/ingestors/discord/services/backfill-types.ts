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
}

export interface ProcessorJobMessage {
  type: "processor";
  guild_channel_key: string;
  guildID: string;
  channelID: string;
  entity_type: "channel" | "thread";
  entity_id?: string;
  event_type: string;
}

export type QueueMessage = SchedulerJobMessage | ProcessorJobMessage;


