import { route } from "rwsdk/router";
import { fetchDiscordMessages } from "./fetch";
import { processDiscordMessages } from "./process";

export const discordIngestorRoutes = [
  route("/fetch", async () => {
    try {
      const result = await fetchDiscordMessages();
      return Response.json({
        success: true,
        message: "Discord fetching started",
        result,
      });
    } catch (error) {
      console.error("Discord fetching error:", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }),

  route("/process", async () => {
    try {
      const result = await processDiscordMessages();
      return Response.json({
        success: true,
        message: `Discord processing completed: ${result.splitsCreated} splits created (${result.splitsByType.thread} threads, ${result.splitsByType.reply_chain} reply chains, ${result.splitsByType.orphaned} orphaned)`,
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
