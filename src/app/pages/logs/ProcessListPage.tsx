import { Heading } from "@/app/components/ui/Heading";
import { link } from "@/app/shared/links";
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

      <ol className="m-4 list-decimal">
        {processes.map((process) => (
          <li key={process.pid}>
            <a
              href={link("/tasks/:containerId/logs/:processId", {
                containerId,
                processId: process.id,
              })}
            >
              {process.command}
            </a>
            <input type="text" value={process.command} />
          </li>
        ))}
      </ol>
    </div>
  );
}
