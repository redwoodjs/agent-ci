import { Container, getContainer } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

export class MachinenContainer extends Container {
  defaultPort = 8910;
  enableInternet: boolean = true;

  sleepAfter = "30m";
}

export function fetchContainer({
  id,
  request,
}: {
  id: string;
  request: Request;
}) {
  let url = new URL(request.url);
  url.port = "8910";
  url.hostname = "localhost";

  console.log(url.toString());

  request = new Request(url, request);

  const headers = new Headers(request.headers);
  const internalQuery = url.searchParams.get("__x_internal_query");
  if (internalQuery) {
    const originalQuery = decodeURIComponent(internalQuery);
    url.search = originalQuery ? "?" + originalQuery : "";
    url.searchParams.delete("__x_internal_query");
  }

  if (headers.has("x-websocket-protocol")) {
    console.log(
      `Renaming 'x-websocket-protocol' to 'sec-websocket-protocol' for ${request.url}`
    );
    headers.set("sec-websocket-protocol", headers.get("x-websocket-protocol")!);
    headers.delete("x-websocket-protocol");
  }

  const requestInit: RequestInit = {
    method: request.method,
    headers,
    body: request.body ? request.body : undefined,
    redirect: request.redirect,
  };

  const containerInstance = getContainer(env.CONTAINER, id);
  return containerInstance.fetch(request, requestInit);
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
