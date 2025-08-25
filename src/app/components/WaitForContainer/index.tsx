import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { RequestInfo } from "rwsdk/worker";

import { bootstrapContainer } from "./actions";
import { BootstrapLogs } from "./BootstrapLogs";

export async function waitForContainer({ params }: RequestInfo) {
  const { containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  const processes = await sandbox.listProcesses();
  let process = processes.find((p) => p.command === "./bootstrap.sh");

  if (!process) {
    process = await bootstrapContainer(containerId);
  }

  console.log(process);

  if (process.status !== "completed" || process.exitCode !== 0) {
    return <BootstrapLogs containerId={containerId} processId={process.id} />;
  }
}
