import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function ProcessListPage({
  params,
}: {
  params: { projectId: string; containerId: string };
}) {
  const { projectId, containerId } = params;
  const sandbox = getSandbox(env.SANDBOX, containerId);
  const processes = await sandbox.listProcesses();

  return (
    <div>
      <h1>Process List</h1>
      <ol>
        {processes.map((process) => (
          <li key={process.pid}>
            <a
              href={`/projects/${projectId}/logs/${containerId}/${process.id}`}
            >
              {process.pid} {process.command} {process.status}{" "}
              {process.exitCode}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}
