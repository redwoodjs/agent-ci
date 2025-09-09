import { defineApp, requestInfo } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute, renderRealtimeClients } from "rwsdk/realtime/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";
import { TaskLayout } from "./app/components/TaskLayout";
import { Home } from "@/app/pages/Home";

import { taskRoutes } from "./app/pages/task/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";
import { chatRoutes } from "./app/pages/chat/routes";
import { authRoutes } from "./app/pages/auth/routes";
import { betterAuthRoutes } from "./better-auth/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
};

const app = defineApp([
  realtimeRoute(() => env.REALTIME_DURABLE_OBJECT),

  render(Document, [
    route("/", ({ ctx }) => {
      // if (!ctx.session?.userId) {
      //   return new Response(null, {
      //     status: 302,
      //     headers: { Location: "/home" },
      //   });
      // }
      return new Response(null, {
        status: 302,
        headers: { Location: "/projects" },
      });
    }),
    route("/home", Home),
    prefix("/auth", betterAuthRoutes),

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
export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
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
