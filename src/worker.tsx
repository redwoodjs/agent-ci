import { defineApp } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute } from "rwsdk/realtime/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { requireAuth } from "./app/pages/auth/interruptors";

import { TaskLayout } from "./app/components/TaskLayout";
import { taskRoutes } from "./app/pages/task/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";
import { chatRoutes } from "./app/pages/chat/routes";
import { authRoutes } from "./app/pages/auth/routes";

import { claudeAuthRoutes } from "./app/pages/claudeAuth/routes";
import { doExploreRoutes } from "./app/plugins/do-explore/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
  user: any;
};

const app = defineApp([
  realtimeRoute(() => env.REALTIME_DURABLE_OBJECT),
  async function authMiddleware({ ctx, request }) {
    try {
      const session = await auth.api.getSession({
        headers: request.headers,
      });

      if (session?.user) {
        ctx.user = session.user;
      }
    } catch (error) {
      console.error("Session error:", error);
    }
  },

  render(Document, [
    route("/", [
      requireAuth,
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/projects" },
        }),
    ]),
    prefix("/auth", authRoutes),
    prefix("/explore", doExploreRoutes), // DO DB Explorer.
    prefix("/projects", projectRoutes),

    layout(TaskLayout, [
      prefix("/tasks/:containerId", [
        requireAuth,
        ...taskRoutes,
        prefix("/chat", chatRoutes),
        prefix("/logs", logsRoutes),
        prefix("/editor", editorRoutes),
        prefix("/term", termRoutes),
        prefix("/preview", previewRoutes),
      ]),
    ]),
  ]),

  prefix("/api/auth/claude", claudeAuthRoutes),
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
