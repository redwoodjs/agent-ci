"use server";

import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

export async function sendMessage(containerId: string, message: string) {
  const sandbox = await getSandbox(env.Sandbox, containerId);
  await sandbox.exec("cd /workspace");
  const process = await sandbox.startProcess(
    `claude --continue --model sonnet --output-format stream-json --verbose --print "${message.replace(
      /"/g,
      '\\"'
    )}"`
  );

  return { id: process.id };
}

export async function streamProcess(containerId: string, processId: string) {
  const sandbox = await getSandbox(env.Sandbox, containerId);
  return await sandbox.streamProcessLogs(processId);
}
