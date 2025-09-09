"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function streamLogs(containerId: string, processId: string) {
  console.log("streamLogs", containerId, processId);
  const sandbox = getSandbox(env.Sandbox, containerId);
  console.log("getting logs for ", processId);
  const stream = await sandbox.streamProcessLogs(processId);
  // note: this can be null, and it shouldn't be... super weird.
  return stream;
}
