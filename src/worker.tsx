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
    // remove "preview/:containerId" from the URL

    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/preview/${params.containerId}`, "");

    return fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
    });
  }),

  route("/tty/:containerId*", async ({ request, params }) => {
    // Proxy WebSocket requests to the container's TTY endpoint
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/tty/${params.containerId}`, "/sandbox/tty");

    return fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
    });
  }),
]);
