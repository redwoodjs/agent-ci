import { defineApp } from "rwsdk/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";
import { TaskLayout } from "./app/components/TaskLayout";

import { taskRoutes } from "./app/pages/task/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";
import { chatRoutes } from "./app/pages/chat/routes";
import { authRoutes } from "./app/pages/auth/routes";
import { doExploreRoutes } from "./app/plugins/do-explore/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
};

const app = defineApp([
  render(Document, [
    route("/", () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "/projects" },
      });
    }),

    prefix("/explore", doExploreRoutes), // DO DB Explorer.

    prefix("/projects", projectRoutes),
    layout(TaskLayout, [
      prefix("/tasks/:containerId", [
        ...taskRoutes,
        prefix("/chat", chatRoutes),
        prefix("/logs", logsRoutes),
        prefix("/editor", editorRoutes),
        prefix("/term", termRoutes),
        prefix("/preview", previewRoutes),
      ]),
    ]),
  ]),

  prefix("/api/auth/claude", authRoutes),
]);

export { Sandbox } from "@cloudflare/sandbox";
export { Database } from "@/db/durableObject";

export default {
  fetch: async function (request, env: Env, cf) {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) {
      return proxyResponse;
    }
    return await app.fetch(request, env, cf);
  },
} as ExportedHandler;
