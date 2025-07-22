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

    return fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
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
