import type { ServerResponse } from "node:http";

// ─── SSE Connections ─────────────────────────────────────────────────────────

const sseClients = new Set<ServerResponse>();

export function addSSEClient(res: ServerResponse) {
  sseClients.add(res);
  res.on("close", () => {
    sseClients.delete(res);
  });
}

export function broadcastEvent(type: string, payload: any) {
  const entry = { type, ...payload, timestamp: Date.now() };
  eventLog.push(entry);
  if (eventLog.length > 100) {
    eventLog.shift();
  }
  const data = JSON.stringify(entry);
  for (const client of sseClients) {
    client.write(`data: ${data}\n\n`);
  }
}

// ─── In-memory event log (ring buffer, last 100 events) ──────────────────────

const eventLog: Array<{ type: string; timestamp: number; [key: string]: any }> = [];

export function getEventLog() {
  return eventLog;
}

export function clearEventLog() {
  eventLog.length = 0;
}
