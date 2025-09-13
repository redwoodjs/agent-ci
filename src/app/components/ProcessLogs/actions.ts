"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function streamLogs(containerId: string, processId: string) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  const stream = await sandbox.streamProcessLogs(processId);
  return stream;
}
