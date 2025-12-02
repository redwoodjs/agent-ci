import { env } from "cloudflare:workers";
import type { GatewayAuditEntry } from "../db/gateway-audit-types";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_GATEWAY: DurableObjectNamespace;
  }
}

interface GatewayEnv {
  DISCORD_GATEWAY: DurableObjectNamespace;
}

const GATEWAY_DO_ID = "discord-gateway";

function getGatewayStub(): DurableObjectStub {
  const gatewayEnv = env as unknown as GatewayEnv;
  const namespace = gatewayEnv.DISCORD_GATEWAY;
  const id = namespace.idFromName(GATEWAY_DO_ID);
  return namespace.get(id);
}

export async function startGateway(): Promise<void> {
  const stub = getGatewayStub();

  const response = await stub.fetch("http://internal/start", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start Gateway: ${error}`);
  }
}

export async function stopGateway(): Promise<void> {
  const stub = getGatewayStub();

  const response = await stub.fetch("http://internal/stop", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to stop Gateway: ${error}`);
  }
}

export async function getGatewayStatus(): Promise<{
  status: "disconnected" | "connecting" | "connected" | "resuming";
  sessionId: string | null;
  sequenceNumber: number | null;
  reconnectAttempts: number;
}> {
  const stub = getGatewayStub();

  const response = await stub.fetch("http://internal/status", {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Gateway status: ${error}`);
  }

  return await response.json();
}

export async function getGatewayAudit(
  limit = 100
): Promise<GatewayAuditEntry[]> {
  const stub = getGatewayStub();
  const url = new URL("http://internal/audit");
  url.searchParams.set("limit", String(limit));

  const response = await stub.fetch(url.toString(), {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Gateway audit log: ${error}`);
  }

  const json = await response.json();
  return (json.entries as GatewayAuditEntry[]) ?? [];
}
