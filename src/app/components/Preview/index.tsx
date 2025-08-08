import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

export async function Preview({ containerId }: { containerId: string }) {
  const sandbox = getSandbox(env.SANDBOX, containerId);
  const ports = await sandbox.getExposedPorts("localhost");
  const url = ports[0].url;
  return <iframe src={url} className="flex-1" />;
}
