import { defineApp } from "rwsdk/worker";
import { route, render, prefix } from "rwsdk/router";
import { Document } from "@/app/Document";

import type { Sandbox } from "@cloudflare/sandbox";

import { fetchContainer, listInstances, newInstance } from "./container";

import { apiRoutes } from "./app/pages/api/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
};

const app = defineApp([
  render(Document, [
    prefix("/projects", projectRoutes),
    prefix("/logs", logsRoutes),
    prefix("/editor", editorRoutes),

    // context
    // claude
    // terminal

    // preview
    // files/

    // route("/claude", ClaudePage),
    // route("/claude/:containerId", ClaudePage),
    // this will be the container id.
    // route("/editor/:containerId", EditorPage),
    // route("/editor/:containerId/*", EditorPage),
    // route("/term/:containerId", TermPage),
  ]),

  prefix("/api", apiRoutes),

  // route("/preview/:containerId*", async ({ request, params }) => {
  //   const url = new URL(request.url);
  //   url.pathname = url.pathname.replace(`/preview/${params.containerId}`, "");

  //   // NOTE (2025-07-30, peterp): I had to disable this because it was causing a fetch error that would
  //   // completely trip up Miniflare. Maybe this is just a dev-issue, will investigate later.

  //   // const headers = new Headers(request.headers);
  //   // const internalQuery = url.searchParams.get("__x_internal_query");
  //   // if (internalQuery) {
  //   //   const originalQuery = decodeURIComponent(internalQuery);
  //   //   url.search = originalQuery ? "?" + originalQuery : "";
  //   //   url.searchParams.delete("__x_internal_query");
  //   // }

  //   // if (headers.has("x-websocket-protocol")) {
  //   //   console.log(
  //   //     `Renaming 'x-websocket-protocol' to 'sec-websocket-protocol' for ${request.url}`
  //   //   );
  //   //   headers.set(
  //   //     "sec-websocket-protocol",
  //   //     headers.get("x-websocket-protocol")!
  //   //   );
  //   //   headers.delete("x-websocket-protocol");
  //   // }
  //   const requestInit: RequestInit = {
  //     method: request.method,
  //     body: request.body ? request.body : undefined,
  //     redirect: request.redirect,
  //   };

  //   return fetchContainer({
  //     containerId: params.containerId,
  //     request: new Request(url, requestInit),
  //     port: "8910",
  //   });
  // }),

  route("/tty/:containerId/attach", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/tty/${params.containerId}`, "/tty");

    const response = await fetchContainer({
      containerId: params.containerId,
      request: new Request(url, request),
    });
    return response;
  }),
]);

export { Sandbox } from "@cloudflare/sandbox";
export { Database } from "@/db/durableObject";

export default {
  fetch: app.fetch,
  // queue: async function queue(batch: MessageBatch) {
  //   if (batch.queue === "container-boot-queue") {
  //     for (const message of batch.messages) {
  //       const body = message.body as { containerId: string; command: string };

  //       console.log("running command", body.command);
  //       const response = await fetchContainer({
  //         containerId: body.containerId,
  //         request: new Request(`http://localhost:8911/tty/exec`, {
  //           method: "POST",
  //           headers: { "Content-Type": "application/json" },
  //           body: JSON.stringify({ command: body.command }),
  //         }),
  //       });
  //     }
  //   }
  // },
};
