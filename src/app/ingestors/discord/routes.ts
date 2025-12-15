import { route } from "rwsdk/router";
import { z } from "zod";
import { env } from "cloudflare:workers";
import {
  updateBackfillState,
  getBackfillState,
} from "@/app/ingestors/discord/services/backfill-state";
import type {
  SchedulerJobMessage,
  GatewayEventMessage,
} from "@/app/ingestors/discord/services/backfill-types";
import { processThreadEvent } from "@/app/ingestors/discord/services/thread-processor";
import { logDiscordRequest, requireGatewayAuth } from "./interruptors";

const backfillRequestSchema = z.object({
  guildID: z.string().min(1),
  channelID: z.string().min(1),
});

const threadRefreshRequestSchema = z.object({
  guildID: z.string().min(1),
  channelID: z.string().min(1),
  threadID: z.string().min(1),
});

const backfillRoute = route("/backfill", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const body = await request.json();
      const { guildID, channelID } = backfillRequestSchema.parse(body);

      const guildChannelKey = `${guildID}/${channelID}`;
      const schedulerQueue = (env as any)
        .DISCORD_SCHEDULER_QUEUE as Queue<SchedulerJobMessage>;

      await updateBackfillState(guildChannelKey, {
        status: "pending",
        messages_cursor: null,
        threads_cursor: null,
        error_message: null,
        error_details: null,
      });

      await schedulerQueue.send({
        type: "scheduler",
        guild_channel_key: guildChannelKey,
        guildID,
        channelID,
        entity_type: "messages",
      });

      const apiResponse = Response.json({
        success: true,
        guild_channel_key: guildChannelKey,
        message: "Backfill job started",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord backfill error:", error);
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

const pauseBackfillRoute = route("/backfill/pause", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const body = await request.json();
      const { guildID, channelID } = backfillRequestSchema.parse(body);

      const guildChannelKey = `${guildID}/${channelID}`;

      await updateBackfillState(guildChannelKey, {
        status: "paused",
        error_message: "Backfill paused manually",
      });

      const apiResponse = Response.json({
        success: true,
        guild_channel_key: guildChannelKey,
        message: "Backfill paused",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord pause backfill error:", error);
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

const statusRoute = route("/backfill/status", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const url = new URL(request.url);
      const guildID = url.searchParams.get("guildID");
      const channelID = url.searchParams.get("channelID");

      if (!guildID || !channelID) {
        return Response.json(
          {
            success: false,
            error: "Missing guildID or channelID query parameters",
          },
          { status: 400 }
        );
      }

      const guildChannelKey = `${guildID}/${channelID}`;
      const state = await getBackfillState(guildChannelKey);

      if (!state) {
        return Response.json(
          { success: false, error: "No backfill state found for this channel" },
          { status: 404 }
        );
      }

      const apiResponse = Response.json({
        success: true,
        guild_channel_key: guildChannelKey,
        state,
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord status check error:", error);
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

// Gateway event endpoint - receives events from external gateway service
const gatewayEventsRoute = route("/events", [
  requireGatewayAuth,
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      // Check if request has a body
      const contentType = request.headers.get("Content-Type");
      if (!contentType || !contentType.includes("application/json")) {
        const errorResponse = Response.json(
          {
            success: false,
            error: "Content-Type must be application/json",
            received: contentType || "none",
          },
          { status: 400 }
        );
        ctx.logCompletion?.(errorResponse);
        return errorResponse;
      }

      // Parse the Discord Gateway event payload
      let body: any;
      try {
        const bodyText = await request.text();
        if (!bodyText || bodyText.trim().length === 0) {
          const errorResponse = Response.json(
            {
              success: false,
              error: "Request body is empty",
            },
            { status: 400 }
          );
          ctx.logCompletion?.(errorResponse);
          return errorResponse;
        }
        body = JSON.parse(bodyText);
      } catch (parseError) {
        console.error("JSON parse error:", parseError);
        const errorResponse = Response.json(
          {
            success: false,
            error: "Invalid JSON in request body",
            details:
              parseError instanceof Error
                ? parseError.message
                : "Unknown parse error",
          },
          { status: 400 }
        );
        ctx.logCompletion?.(errorResponse);
        return errorResponse;
      }

      // Validate the event structure (op, t, s, d)
      const eventSchema = z.object({
        op: z.number(),
        t: z.string().nullable(),
        s: z.number().nullable(),
        d: z.any(),
      });

      let event: z.infer<typeof eventSchema>;
      try {
        event = eventSchema.parse(body);
      } catch (validationError) {
        console.error("Schema validation error:", validationError);
        if (validationError instanceof z.ZodError) {
          const errorResponse = Response.json(
            {
              success: false,
              error: "Event validation failed",
              details: validationError.issues,
              received: body,
            },
            { status: 400 }
          );
          ctx.logCompletion?.(errorResponse);
          return errorResponse;
        }
        throw validationError;
      }

      // Only process dispatch events (op 0) with event types
      if (event.op !== 0 || !event.t) {
        // Non-dispatch events (heartbeat, identify, etc.) are not processed
        const apiResponse = Response.json({
          success: true,
          message: "Event ignored (not a dispatch event)",
        });
        ctx.logCompletion?.(apiResponse);
        return apiResponse;
      }

      // Queue the event for processing
      const gatewayEventsQueue = (env as any).DISCORD_GATEWAY_EVENTS_QUEUE as
        | Queue<GatewayEventMessage>
        | undefined;

      if (!gatewayEventsQueue) {
        console.error(
          "DISCORD_GATEWAY_EVENTS_QUEUE is not configured in environment"
        );
        const errorResponse = Response.json(
          {
            success: false,
            error: "Gateway events queue not configured",
            message:
              "DISCORD_GATEWAY_EVENTS_QUEUE binding is missing. Please check wrangler.jsonc configuration.",
          },
          { status: 500 }
        );
        ctx.logCompletion?.(errorResponse);
        return errorResponse;
      }

      await gatewayEventsQueue.send({
        type: "gateway_event",
        op: event.op,
        t: event.t,
        s: event.s,
        d: event.d,
      });

      const apiResponse = Response.json({
        success: true,
        message: "Event queued for processing",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord Gateway event error:", error);
      const errorResponse = Response.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          type: error instanceof Error ? error.constructor.name : typeof error,
        },
        { status: 500 }
      );
      ctx.logCompletion?.(errorResponse);
      return errorResponse;
    }
  },
]);

const refreshThreadRoute = route("/thread/refresh", [
  requireGatewayAuth,
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const body = await request.json();
      const { guildID, channelID, threadID } = threadRefreshRequestSchema.parse(
        body
      );

      await processThreadEvent(guildID, channelID, threadID);

      const r2Key = `discord/${guildID}/${channelID}/threads/${threadID}/latest.json`;
      const apiResponse = Response.json({
        success: true,
        r2Key,
        message: "Thread refresh completed",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord thread refresh error:", error);
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

export const routes = [
  backfillRoute,
  pauseBackfillRoute,
  statusRoute,
  gatewayEventsRoute,
  refreshThreadRoute,
];
