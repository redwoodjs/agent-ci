import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import { bootstrapContainer } from "./actions";
import { BootLogs } from "./boot-logs";

export async function waitForContainer({ params }: RequestInfo) {
  const { containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  // There seems to be a race condition here.
  // We start this twice?
  const processes = await sandbox.listProcesses();
  let process = processes.find((p) => p.command === "./bootstrap.sh");
  if (!process) {
    process = await bootstrapContainer(containerId);
  }
  if (process?.status !== "completed" || process?.exitCode !== 0) {
    return <BootLogs containerId={containerId} processId={process.id!} />;
  }
}
