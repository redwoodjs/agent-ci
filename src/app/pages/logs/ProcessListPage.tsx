import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function ProcessListPage({
  params,
}: {
  params: { containerId: string };
}) {
  console.log("ProcessListPage", params);
  const { containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  const processes = await sandbox.listProcesses();

  return (
    <>
      <h1>Process</h1>

      <ol>
        {processes.map((process) => (
          <li key={process.pid}>
            <a href={`/logs/${containerId}/${process.id}`}>{process.command}</a>
          </li>
        ))}
      </ol>
    </>
  );
}
