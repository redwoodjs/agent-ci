import { Heading } from "@/app/components/ui/Heading";
import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function ProcessListPage({
  params,
}: {
  params: { containerId: string };
}) {
  const { containerId } = params;
  const sandbox = getSandbox(env.Sandbox, containerId);
  const processes = await sandbox.listProcesses();

  return (
    <div>
      <Heading>Logs</Heading>

      <ol className="m-4">
        {processes.map((process) => (
          <li key={process.pid}>
            <a href={`/logs/${containerId}/${process.id}`}>{process.command}</a>
          </li>
        ))}
      </ol>
    </div>
  );
}
