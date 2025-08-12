"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export function streamLogs(containerId: string, processId: string) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  return sandbox.streamProcessLogs(processId);
}
