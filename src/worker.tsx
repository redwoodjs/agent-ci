import { defineApp } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute } from "rwsdk/realtime/worker";
import { render, prefix, route, layout } from "rwsdk/router";

import { type Sandbox, proxyToSandbox } from "@cloudflare/sandbox";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { requireAuth } from "./app/pages/auth/interruptors";
import { setCommonHeaders } from "./app/headers";

import { authRoutes } from "./app/pages/auth/routes";

// TASKS
import { TaskLayout } from "./app/components/task-layout";
import { taskRoutes } from "./app/pages/task/routes";
// TASK SUBPAGES
import { chatRoutes } from "./app/pages/chat/routes";
import { transcriptRoutes } from "./app/pages/task/subpages/transcripts/routes";
import { logsRoutes } from "./app/pages/logs/routes";
import { projectRoutes } from "./app/pages/project/routes";
import { editorRoutes } from "./app/pages/editor/routes";
import { termRoutes } from "./app/pages/term/routes";
import { previewRoutes } from "./app/pages/preview/routes";

import { doExploreRoutes } from "./app/plugins/do-explore/routes";
import { contextStreamRoutes } from "./app/pages/context-stream/routes";

import { streamRoutes } from "./app/pages/streams/routes";
import { sourceRoutes } from "./app/pages/sources/routes";
import { db } from "./db";

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
      // console.error("Session error:", error);
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

    route("/seed", async () => {
      await db
        .insertInto("sources")
        .values([
          {
            id: 1,
            name: "Technical discussions",
            description: "Technical team: Peter, Justin & Herman",
            bucket: "meetings/",
            url: "https://discord.gg/redwoodjs",
            type: "transcripts",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 2,
            name: "GitHub PRs",
            description: "redwoodjs/sdk",
            bucket: "prs/",
            url: "https://github.com/redwoodjs/sdk/pulls",
            type: "pull-requests",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ])
        .execute();

      await db
        .insertInto("artifacts")
        .values([
          // Meetings
          {
            id: 1,
            sourceID: 1,
            bucketPath: "meetings/2025-07-29-1/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 2,
            sourceID: 1,
            bucketPath: "meetings/2025-09-10-1/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 3,
            sourceID: 1,
            bucketPath: "meetings/2025-09-18-1/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          // Pull Requests
          {
            id: 4,
            sourceID: 2,
            bucketPath: "prs/redwoodjs-sdk-pr-663/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 5,
            sourceID: 2,
            bucketPath: "prs/redwoodjs-sdk-pr-713/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          {
            id: 6,
            sourceID: 2,
            bucketPath: "prs/redwoodjs-sdk-pr-752/",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ])
        .execute();

      //
      await db
        .insertInto("streams")
        .values([
          {
            id: 1,
            name: "Radix UI",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            sources: "[]",
            subjects: "[]",
            events: "[]",
          },
        ])
        .execute();
    }),

    // prefix("/auth", authRoutes),
    prefix("/dox", doExploreRoutes),
    // prefix("/projects", projectRoutes),
    prefix("/streams", streamRoutes),
    prefix("/sources", sourceRoutes),

    // layout(TaskLayout, [
    //   prefix("/tasks/:containerId", [
    //     ...taskRoutes,
    //     prefix("/transcript", transcriptRoutes),
    //     prefix("/chat", chatRoutes),
    //     prefix("/logs", logsRoutes),
    //     prefix("/editor", editorRoutes),
    //     prefix("/term", termRoutes),
    //     prefix("/preview", previewRoutes),
    //   ]),
    // ]),
  ]),

  prefix("/cs", contextStreamRoutes),
]);

export { Sandbox } from "@cloudflare/sandbox";
export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";

export default {
  fetch: async function (request, env: Env, cf) {
    // TODO(peterp, 2025-09-18): This is a hack to get the chat working.
    // Get the proper ports from the database.

    const ports = ["4096", "8910", "5173"];

    // for (const port of ports) {
    //   if (request.url.includes(port)) {
    //     return proxyToSandbox(request, env);
    //   }
    // }

    const url = new URL(request.url);
    const port = url.hostname.split("-")[0];
    if (ports.includes(port)) {
      // we only record visits to the users tools.

      // Record that the user visited this sandbox.
      // try {
      //   const containerId = url.hostname
      //     .replace("5173-", "")
      //     .replace(".localhost", "");

      //   // Get laneId from database asynchronously (don't await to avoid blocking the request)
      //   const { laneId } = await db
      //     .selectFrom("tasks")
      //     .select("laneId")
      //     .where("containerId", "=", containerId)
      //     .executeTakeFirstOrThrow();

      //   recordPageview(request, containerId, laneId);
      // } catch (error) {
      //   console.error("Error in visit recording setup:", error);
      // }

      return proxyToSandbox(request, env);
    }

    return await app.fetch(request, env, cf);
  },
} as ExportedHandler;
