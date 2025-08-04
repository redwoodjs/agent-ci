import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

export class MachinenContainer extends Container {
  enableInternet = true;
  defaultPort = 8910;

  sleepAfter = "60m";
}

const ACTIVE_CONTAINERS = new Set<string>();

export function fetchContainer({
  containerId,
  request,
  port = "8911",
}: {
  containerId: string;
  request: Request;
  port?: string;
}) {
  let url = new URL(request.url);
  url.port = port;
  url.hostname = "localhost";

  console.log("----------------------------------");
  console.log(url.toString());
  console.log("----------------------------------");

  request = new Request(url, request);

  const containerInstance = getContainer(env.CONTAINER, containerId);
  return containerInstance.fetch(request);
}

export async function newInstance(
  containerId: string = env.CONTAINER.newUniqueId().toString()
) {
  const instance = getContainer(env.CONTAINER, containerId);
  ACTIVE_CONTAINERS.add(containerId);
  return instance;
}

export function listInstances(): string[] {
  return Array.from(ACTIVE_CONTAINERS);
}

export function getInstance(containerId: string) {
  return getContainer(env.CONTAINER, containerId);
}
