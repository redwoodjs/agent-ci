import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class MachinenContainer extends Container {
  enableInternet = true;
  defaultPort = 8910;

  sleepAfter = "60m";
}

export function fetchContainer({
  id,
  request,
  port = "8911",
}: {
  id: string;
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

  const containerInstance = getContainer(env.CONTAINER, id);
  return containerInstance.fetch(request);
}

const activeContainers = new Set<string>();

export function startNewContainer() {
  const id = env.CONTAINER.newUniqueId();
  activeContainers.add(id.toString());

  return getContainer(env.CONTAINER, id.toString());
}

export function listContainers(): string[] {
  return Array.from(activeContainers);
}

export function removeContainer(containerId: string): boolean {
  return activeContainers.delete(containerId);
}
