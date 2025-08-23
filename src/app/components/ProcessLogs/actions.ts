"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function streamLogs(
  containerId: string,
  processId: string,
  signal?: AbortSignal
) {
  console.log("streamLogs", containerId, processId);
  const sandbox = getSandbox(env.Sandbox, containerId);
  console.log("getting logs for ", processId);
  return await sandbox.streamProcessLogs(processId, {
    // Use the provided signal for proper cancellation control
    signal,
  });
}
