import { defineApp } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute } from "rwsdk/realtime/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { requireAuth } from "./app/pages/auth/interruptors";
import { setCommonHeaders } from "./app/headers";
import { recordPageview } from "@/app/services/pageviews";
import { db } from "@/db";

import { createOpencodeClient as createOpencodeClientClient } from "@opencode-ai/sdk/client";

import { TaskLayout } from "./app/components/TaskLayout";
import { taskRoutes } from "./app/pages/task/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";
import { chatRoutes } from "./app/pages/chat/routes";
import { transcriptRoutes } from "./app/pages/transcript/routes";
import { authRoutes } from "./app/pages/auth/routes";

import { claudeAuthRoutes } from "./app/pages/claudeAuth/routes";
import { doExploreRoutes } from "./app/plugins/do-explore/routes";

export type AppContext = {
  sandbox: DurableObjectStub<Sandbox<unknown>>;
  user: any;
};

const app = defineApp([
  setCommonHeaders(),
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
    prefix("/dox", doExploreRoutes),
    prefix("/projects", projectRoutes),

    layout(TaskLayout, [
      prefix("/tasks/:containerId", [
        ...taskRoutes,
        prefix("/transcript", transcriptRoutes),
        prefix("/chat", chatRoutes),
        prefix("/logs", logsRoutes),
        prefix("/editor", editorRoutes),
        prefix("/term", termRoutes),
        prefix("/preview", previewRoutes),
      ]),
    ]),
  ]),

  route("/oc", async function () {
    // createOpencodeClient;
    createOpencodeClientClient;
    // const client = createOpencodeClient({
    //   baseUrl: "http://localhost:4096",
    //   responseStyle: "data",
    // });
    return new Response("hey!");
  }),

  prefix("/api/auth/claude", claudeAuthRoutes),
]);

export { Sandbox } from "@cloudflare/sandbox";
export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";

export default {
  fetch: async function (request, env: Env, cf) {
    const url = new URL(request.url);
    if (url.hostname.includes("5173")) {
      // Record that the user visited this sandbox.
      try {
        const containerId = url.hostname
          .replace("5173-", "")
          .replace(".localhost", "");

        // Get laneId from database asynchronously (don't await to avoid blocking the request)
        const { laneId } = await db
          .selectFrom("tasks")
          .select("laneId")
          .where("containerId", "=", containerId)
          .executeTakeFirstOrThrow();

        recordPageview(request, containerId, laneId);
      } catch (error) {
        console.error("Error in visit recording setup:", error);
      }

      return proxyToSandbox(request, env);
    }

    return await app.fetch(request, env, cf);
  },
} as ExportedHandler;
