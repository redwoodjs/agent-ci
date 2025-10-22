import { route } from "rwsdk/router";
import { ingestDiscordMessages } from "./ingest";
import { processDiscordMessages } from "./process";

export const discordIngestorRoutes = [
  route("/ingestors/discord/ingest", async () => {
    try {
      const result = await ingestDiscordMessages();
      return Response.json({
        success: true,
        message: "Discord ingestion started",
        result,
      });
    } catch (error) {
      console.error("Discord ingestion error:", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }),

  route("/ingestors/discord/process", async () => {
    try {
      const result = await processDiscordMessages();
      return Response.json({
        success: true,
        message: "Discord processing completed",
        result,
      });
    } catch (error) {
      console.error("Discord processing error:", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }),
];
