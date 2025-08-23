import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";

export async function Preview({ containerId }: { containerId: string }) {
  const sandbox = getSandbox(env.Sandbox, containerId);
  let ports = await sandbox.getExposedPorts("localhost");

  ports = ports.filter((p) => p.port !== 8910);

  // TODO: Adding the port here should not be required.
  const url = ports[0].url.substring(0, ports[0].url.length - 1) + ":5173/";
  return (
    <iframe
      src={url}
      className="flex-1 h-full"
      sandbox="allow-scripts allow-same-origin"
    />
  );
}
