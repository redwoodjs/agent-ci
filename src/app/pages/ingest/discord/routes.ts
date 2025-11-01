import { route } from "rwsdk/router";
import { discordJsonToMarkdown } from "./services/discord-to-markdown";
import { splitDiscordConversations } from "./services/conversation-splitter";
import {
  validateDiscordConvert,
  validateDiscordBatch,
  logDiscordRequest,
  rateLimitDiscord,
} from "./interruptors";

interface DiscordConvertRequest {
  messages: any[];
  guildId?: string;
  channelId?: string;
  exportTimestamp?: string;
  splitConversations?: boolean;
}

interface DiscordConvertResponse {
  success: boolean;
  rawMarkdown?: string;
  metadata?: {
    guildId: string;
    channelId: string;
    exportTimestamp: string;
    messageCount: number;
    dateRange: {
      start: string;
      end: string;
    };
  };
  conversationSplits?: Array<{
    id: string;
    startTime: string;
    endTime: string;
    messageCount: number;
    participantCount: number;
    threadCount: number;
    participants: string[];
    splitType: string;
  }>;
  error?: string;
}

function extractMetadataFromMessages(messages: any[]): {
  messageCount: number;
  dateRange: { start: string; end: string };
} {
  if (messages.length === 0) {
    return { messageCount: 0, dateRange: { start: "", end: "" } };
  }

  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return {
    messageCount: messages.length,
    dateRange: {
      start: sortedMessages[0].timestamp,
      end: sortedMessages[sortedMessages.length - 1].timestamp,
    },
  };
}

export const convert = route("/ingest/discord/convert", [
  logDiscordRequest,
  rateLimitDiscord,
  validateDiscordConvert,
  async ({ ctx }: { ctx: any }) => {
    try {
      const {
        messages,
        guildId,
        channelId,
        exportTimestamp,
        splitConversations = false,
      } = ctx.validatedData;

      console.log(`Converting ${messages.length} Discord messages`);

      // Extract metadata
      const contentMetadata = extractMetadataFromMessages(messages);
      const metadata = {
        guildId: guildId || "unknown",
        channelId: channelId || "unknown",
        exportTimestamp: exportTimestamp || new Date().toISOString(),
        messageCount: contentMetadata.messageCount,
        dateRange: contentMetadata.dateRange,
      };

      // Convert to markdown
      const rawMarkdown = discordJsonToMarkdown(messages);

      const response: DiscordConvertResponse = {
        success: true,
        rawMarkdown,
        metadata,
      };

      // Add conversation splits if requested
      if (splitConversations) {
        const splits = splitDiscordConversations(messages);
        response.conversationSplits = splits.map((split) => ({
          id: split.id,
          startTime: split.startTime,
          endTime: split.endTime,
          messageCount: split.messageCount,
          participantCount: split.participantCount,
          threadCount: split.threadCount,
          participants: split.participants,
          splitType: split.splitType,
        }));
      }

      const apiResponse = Response.json(response);
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord conversion error:", error);
      const errorResponse = Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
      ctx.logCompletion?.(errorResponse);
      return errorResponse;
    }
  },
]);

export const batchConvert = route("/ingest/discord/batch", [
  logDiscordRequest,
  rateLimitDiscord,
  validateDiscordBatch,
  async ({ ctx }: { ctx: any }) => {
    try {
      const { files } = ctx.validatedData;

      console.log(`Batch converting ${files.length} Discord files`);

      const results = [];
      let successCount = 0;
      let errorCount = 0;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        console.log(`Processing file ${i + 1}/${files.length}`);

        try {
          const {
            messages,
            guildId,
            channelId,
            exportTimestamp,
            splitConversations = false,
          } = file;

          // Extract metadata
          const contentMetadata = extractMetadataFromMessages(messages);
          const metadata = {
            guildId: guildId || "unknown",
            channelId: channelId || "unknown",
            exportTimestamp: exportTimestamp || new Date().toISOString(),
            messageCount: contentMetadata.messageCount,
            dateRange: contentMetadata.dateRange,
          };

          // Convert to markdown
          const rawMarkdown = discordJsonToMarkdown(messages);

          const result: DiscordConvertResponse = {
            success: true,
            rawMarkdown,
            metadata,
          };

          // Add conversation splits if requested
          if (splitConversations) {
            const splits = splitDiscordConversations(messages);
            result.conversationSplits = splits.map((split) => ({
              id: split.id,
              startTime: split.startTime,
              endTime: split.endTime,
              messageCount: split.messageCount,
              participantCount: split.participantCount,
              threadCount: split.threadCount,
              participants: split.participants,
              splitType: split.splitType,
            }));
          }

          results.push(result);
          successCount++;
        } catch (error) {
          console.error(`Error processing file ${i + 1}:`, error);
          results.push({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          errorCount++;
        }
      }

      const apiResponse = Response.json({
        success: true,
        results,
        summary: {
          totalFiles: files.length,
          successCount,
          errorCount,
        },
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord batch conversion error:", error);
      const errorResponse = Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
      ctx.logCompletion?.(errorResponse);
      return errorResponse;
    }
  },
]);

export const upload = route("/ingest/discord/upload", [
  logDiscordRequest,
  rateLimitDiscord,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const body: {
        rawMarkdown: string;
        metadata: any;
        conversationSplits?: any[];
      } = await request.json();

      const { rawMarkdown, metadata, conversationSplits } = body;

      if (!rawMarkdown || !metadata) {
        return Response.json(
          { success: false, error: "Missing required fields" },
          { status: 400 }
        );
      }

      console.log(`Uploading Discord data for channel ${metadata.channelId}`);

      // TODO: Implement actual R2 upload
      // const r2Key = `discord/${metadata.guildId}/${metadata.channelId}/${metadata.exportTimestamp}/raw.md`;
      // await uploadToR2(rawMarkdown, r2Key);

      // For now, just return success
      const apiResponse = Response.json({
        success: true,
        message: "Upload simulated successfully",
        r2Key: `discord/${metadata.guildId}/${metadata.channelId}/${metadata.exportTimestamp}/raw.md`,
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord upload error:", error);
      const errorResponse = Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        { status: 500 }
      );
      ctx.logCompletion?.(errorResponse);
      return errorResponse;
    }
  },
]);
