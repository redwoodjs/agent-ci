import { route } from "rwsdk/router";
import { fetchDiscordMessages } from "./fetch";
import { processDiscordMessages } from "./process";
import {
  splitDiscordMessages,
  splitAllUnprocessedArtifacts,
} from "./split-conversations";
import {
  extractSubjectFromConversation,
  extractSubjectsFromAllSplits,
} from "./extract-subjects";

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

  route("/store", async () => {
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

  route("/split-conversations", async ({ request }) => {
    try {
      const url = new URL(request.url);
      const artifactID = url.searchParams.get("artifactID");

      if (artifactID) {
        const result = await splitDiscordMessages(parseInt(artifactID));
        return Response.json({
          success: !result.error,
          message: result.error
            ? "Error splitting conversations"
            : "Conversations split successfully",
          result,
        });
      } else {
        const result = await splitAllUnprocessedArtifacts();
        return Response.json({
          success: result.errors.length === 0,
          message: "Conversation splitting completed",
          result,
        });
      }
    } catch (error) {
      console.error("Conversation splitting error:", error);
      return Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
    }
  }),

  route("/extract-subjects", async ({ request }) => {
    try {
      const url = new URL(request.url);
      const conversationSplitID = url.searchParams.get("conversationSplitID");
      const artifactID = url.searchParams.get("artifactID");

      if (conversationSplitID) {
        const result = await extractSubjectFromConversation(
          parseInt(conversationSplitID)
        );
        return Response.json({
          success: result.success,
          message: result.error
            ? "Error extracting subject"
            : "Subject extracted successfully",
          result,
        });
      } else {
        const result = await extractSubjectsFromAllSplits(
          artifactID ? parseInt(artifactID) : undefined
        );
        return Response.json({
          success: result.errors.length === 0,
          message: "Subject extraction completed",
          result,
        });
      }
    } catch (error) {
      console.error("Subject extraction error:", error);
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
