"use server";

import { sendClaudeMessage } from "@/lib/claude";
import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { ClaudeModel } from "@/types/claude";

export async function sendAndStreamClaudeMessage(
  containerId: string,
  message: string,
  model: ClaudeModel = "default"
) {
  const process = await sendClaudeMessage(containerId, message, model);
  const sandbox = await getSandbox(env.Sandbox, containerId);
  const stream = await sandbox.streamProcessLogs(process.id);
  return stream;
}
