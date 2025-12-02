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
import { logDiscordRequest, requireGatewayAuth } from "./interruptors";

const backfillRequestSchema = z.object({
  guildID: z.string().min(1),
  channelID: z.string().min(1),
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
      // Parse the Discord Gateway event payload
      const body = await request.json();

      // Validate the event structure (op, t, s, d)
      const eventSchema = z.object({
        op: z.number(),
        t: z.string().nullable(),
        s: z.number().nullable(),
        d: z.any(),
      });

      const event = eventSchema.parse(body);

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
      const gatewayEventsQueue = (env as any)
        .DISCORD_GATEWAY_EVENTS_QUEUE as Queue<GatewayEventMessage>;

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
        },
        { status: 400 }
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
];
