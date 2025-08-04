import { env } from "cloudflare:workers";
import { Container, getContainer } from "@cloudflare/containers";

export class MachinenContainer extends Container {
  enableInternet = true;
  sleepAfter = "60m";
  defaultPort = 8910;
  onError(error: unknown) {
    console.error("container error", error);
  }
  onStart() {
    console.log("container started", this.ctx.id);
  }
  onStop() {
    console.log("container stopped", this.ctx.id);
  }
  ports = [8910, 8911];
}

const ACTIVE_CONTAINERS = new Set<string>();
// TODO: Do this properly.
const INSTANCE_NAMES = ["one", "two", "three", "four", "five"];

export function fetchContainer({
  containerId,
  request,
  port = "8911",
}: {
  containerId: string;
  request: Request;
  port?: string;
}) {
  if (!containerId) {
    throw new Error("containerId is required");
  }

  let url = new URL(request.url);
  url.port = port;
  url.hostname = "localhost";

  console.log("-".repeat(80));
  console.log(`[machine:${containerId}]`, url.toString());
  console.log("-".repeat(80));

  request = new Request(url, request);

  const containerInstance = getContainer(env.CONTAINER, containerId);
  return containerInstance.fetch(request);
}

export async function newInstance(
  containerId: string = env.CONTAINER.newUniqueId().toString()
) {
  const instanceName = INSTANCE_NAMES[ACTIVE_CONTAINERS.size];
  const instance = getContainer(env.CONTAINER, instanceName);
  ACTIVE_CONTAINERS.add(instanceName);
  return instance;
}

export function listInstances(): string[] {
  return Array.from(ACTIVE_CONTAINERS);
}

export function getInstance(containerId: string) {
  return getContainer(env.CONTAINER, containerId);
}
