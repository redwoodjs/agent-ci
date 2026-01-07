import { GatewayOpCode } from "../utils/discord-api";

export interface GatewayAuditEntry {
  ts: number;
  kind: "dispatch" | "gateway" | "error";
  op?: GatewayOpCode;
  sequence?: number | null;
  eventType?: string | null;
  status?: string;
  error?: string;
  r2Key?: string;
  fileKey?: string;
  guildId?: string | null;
  channelId?: string | null;
  threadId?: string | null;
  metadata?: unknown;
}

















