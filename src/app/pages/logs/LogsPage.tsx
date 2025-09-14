import { RequestInfo } from "rwsdk/worker";

import { ProcessLogs } from "@/app/components/ProcessLogs";
import { Heading } from "@/app/components/ui/Heading";
import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function LogsPage({ params }: RequestInfo) {
  const { containerId, processId } = params;

  const sandbox = getSandbox(env.Sandbox, containerId);
  const processes = await sandbox.listProcesses();
  const process = processes.find((p) => p.id === processId);
  if (!process) {
    return <div>Process not found</div>;
  }

  return (
    <>
      <Heading>Logs</Heading>
      <p>Command: {process.command}</p>
      <p>PID: {process.pid}</p>

      <a
        href={`http://8910-${containerId}.localhost:5173/process/${process.pid}/${processId}`}
      >
        View Logs
      </a>

      <div className="m-4">
        <ProcessLogs containerId={containerId} processId={processId} />
      </div>
    </>
  );
}
