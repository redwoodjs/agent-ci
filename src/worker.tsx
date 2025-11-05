import { defineApp } from "rwsdk/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { setCommonHeaders } from "./app/headers";

import { authRoutes } from "./app/pages/auth/routes";
import { sourceRoutes } from "./app/pages/sources/routes";
import { routes as discordRoutes } from "./app/pages/ingest/discord/routes";
import { routes as cursorIngestorRoutes } from "./app/ingestors/cursor/routes";
import { HomePage } from "./app/pages/HomePage";

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
    route("/", [HomePage]),

    prefix("/auth", authRoutes),
    prefix("/sources", sourceRoutes),
  ]),

  prefix("/ingest/discord", discordRoutes),
  prefix("/ingestors/cursor", cursorIngestorRoutes),
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { CursorEventsDurableObject } from "@/app/ingestors/cursor/db/durableObject";
export {
  Container,
  MachinenContainer,
  Sandbox,
  ProcessLog,
  RawDiscordDatabase,
} from "@/db/deprecatedDurableObjects";

export default {
  fetch: app.fetch,
} as ExportedHandler;
