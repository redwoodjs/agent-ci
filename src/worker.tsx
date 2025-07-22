import { defineApp } from "rwsdk/worker";
import { route, render } from "rwsdk/router";
import { Document } from "@/app/Document";

import { EditorPage } from "@/app/pages/editor/EditorPage";
import { TermPage } from "@/app/pages/TermPage";
import { fetchContainer } from "./container";
import { SessionPage } from "./app/pages/session/SessionPage";

export { MachinenContainer } from "./container";

export default defineApp([
  render(Document, [
    route("/", () => {
      return <SessionPage />;
    }),
    // this will be the container id.
    route("/editor/:containerId", EditorPage),
    route("/editor/:containerId/*", EditorPage),
    route("/term/:containerId", TermPage),
  ]),

  route("/preview/:containerId*", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/preview/${params.containerId}`, "");

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
      headers.set(
        "sec-websocket-protocol",
        headers.get("x-websocket-protocol")!
      );
      headers.delete("x-websocket-protocol");
    }
    const requestInit: RequestInit = {
      method: request.method,
      body: request.body ? request.body : undefined,
      redirect: request.redirect,
    };

    return fetchContainer({
      id: params.containerId,
      request: new Request(url, requestInit),
      port: "8910",
    });
  }),

  route("/tty/:containerId/attach", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/tty/${params.containerId}`, "/tty");

    const response = await fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
    });
    return response;
  }),
]);
