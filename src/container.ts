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

  // const headers = new Headers(request.headers);
  // const internalQuery = url.searchParams.get("__x_internal_query");
  // if (internalQuery) {
  //   const originalQuery = decodeURIComponent(internalQuery);
  //   url.search = originalQuery ? "?" + originalQuery : "";
  //   url.searchParams.delete("__x_internal_query");
  // }

  // if (headers.has("x-websocket-protocol")) {
  //   console.log(
  //     `Renaming 'x-websocket-protocol' to 'sec-websocket-protocol' for ${request.url}`
  //   );
  //   headers.set("sec-websocket-protocol", headers.get("x-websocket-protocol")!);
  //   headers.delete("x-websocket-protocol");
  // }

  // const requestInit: RequestInit = {
  //   method: request.method,
  //   body: request.body ? request.body : undefined,
  //   redirect: request.redirect,
  // };

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
