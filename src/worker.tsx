import { defineApp } from "rwsdk/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { setCommonHeaders } from "./app/headers";

import { authRoutes } from "./app/pages/auth/routes";
import { sourceRoutes } from "./app/pages/sources/routes";
import { discordIngestorRoutes } from "./app/ingestors/discord/routes";
import { doExploreRoutes } from "./app/plugins/do-explore/routes";

export type AppContext = {
  user: any;
};

const app = defineApp([
  setCommonHeaders(),
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
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/sources" },
        }),
    ]),

    prefix("/auth", authRoutes),
    prefix("/sources", sourceRoutes),
    prefix("/dox", doExploreRoutes),
  ]),

  prefix("/ingestors/discord", discordIngestorRoutes),
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { RawDiscordDatabase } from "@/app/ingestors/discord/db";

export default {
  fetch: app.fetch,
} as ExportedHandler;
