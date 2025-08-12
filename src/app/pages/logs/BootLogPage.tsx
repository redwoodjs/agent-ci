import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";

export async function BootLogPage({
  params,
}: {
  params: { containerId: string };
}) {
  const sandbox = getSandbox(env.Sandbox, params.containerId);
  const bootLog = await sandbox.readFile("/tmp/boot.log");
  return <div>{bootLog.content}</div>;
}
