import { defineApp } from "rwsdk/worker";
import { route, render, prefix } from "rwsdk/router";
import { Document } from "@/app/Document";

import {
  type Sandbox,
  type SandboxEnv,
  proxyToSandbox,
} from "@cloudflare/sandbox";

import { fetchContainer } from "./container";

import { apiRoutes } from "./app/pages/api/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
};

const app = defineApp([
  render(Document, [
    prefix("/projects", projectRoutes),

    prefix("/logs", logsRoutes),
    prefix("/editor", editorRoutes),
    prefix("/claude", editorRoutes),
    prefix("/term/", termRoutes),
    prefix("/preview", previewRoutes),

    // prefix("/preview", editorRoutes),

    // route("/claude", ClaudePage),
    // route("/claude/:containerId", ClaudePage),
    // this will be the container id.
  ]),

  prefix("/api", apiRoutes),
]);

export { Sandbox } from "@cloudflare/sandbox";
export { Database } from "@/db/durableObject";

export default {
  fetch: async function (request, env: Env, cf) {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      console.log("proxyResponse", proxyResponse);
      return proxyResponse;
    }

    return await app.fetch(request, env, cf);
  },
} as ExportedHandler;
