import { env } from "cloudflare:workers";

declare module "rwsdk/worker" {
  interface WorkerEnv {
    DISCORD_GATEWAY: DurableObjectNamespace;
  }
}

interface GatewayEnv {
  DISCORD_GATEWAY: DurableObjectNamespace;
}

const GATEWAY_DO_ID = "discord-gateway";

export async function startGateway(): Promise<void> {
  const gatewayEnv = env as unknown as GatewayEnv;
  const namespace = gatewayEnv.DISCORD_GATEWAY;
  const id = namespace.idFromName(GATEWAY_DO_ID);
  const stub = namespace.get(id);

  const response = await stub.fetch("http://internal/start", {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start Gateway: ${error}`);
  }
}

export async function stopGateway(): Promise<void> {
  const gatewayEnv = env as unknown as GatewayEnv;
  const namespace = gatewayEnv.DISCORD_GATEWAY;
  const id = namespace.idFromName(GATEWAY_DO_ID);
  const stub = namespace.get(id);

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
  const gatewayEnv = env as unknown as GatewayEnv;
  const namespace = gatewayEnv.DISCORD_GATEWAY;
  const id = namespace.idFromName(GATEWAY_DO_ID);
  const stub = namespace.get(id);

  const response = await stub.fetch("http://internal/status", {
    method: "GET",
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to get Gateway status: ${error}`);
  }

  return await response.json();
}
