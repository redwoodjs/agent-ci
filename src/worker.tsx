import { defineApp } from "rwsdk/worker";
import { env } from "cloudflare:workers";
import { realtimeRoute } from "rwsdk/realtime/worker";
import { render, prefix, route } from "rwsdk/router";

import { Document } from "@/app/Document";

import { auth } from "@/app/pages/auth/auth";
import { setCommonHeaders } from "./app/headers";

import { authRoutes } from "./app/pages/auth/routes";
import { sourceRoutes } from "./app/pages/sources/routes";
import { db } from "./db";
import { discordIngestorRoutes } from "./app/ingestors/discord/routes";

export type AppContext = {
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
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: "/sources" },
        }),
    ]),

    prefix("/auth", authRoutes),
    prefix("/sources", sourceRoutes),
  ]),

<<<<<<< Updated upstream
  prefix("/ingestors/discord", discordIngestorRoutes),

  prefix("/cs", contextStreamRoutes),
=======
  route("/ingest/discord", async () => {
    console.log("Ingesting Discord messages");
    const results = await ingestDiscordMessages();
    console.log("Discord messages ingested");
    return Response.json({ message: "Discord messages ingested" });
  }),
>>>>>>> Stashed changes
]);

export { RealtimeDurableObject } from "rwsdk/realtime/durableObject";
export { Database } from "@/db/durableObject";
export { RawDiscordDatabase } from "@/app/ingestors/discord/db";

export default {
  fetch: app.fetch,
} as ExportedHandler;
