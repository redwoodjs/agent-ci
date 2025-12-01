import { route } from "rwsdk/router";
import { z } from "zod";
import { env } from "cloudflare:workers";
import {
  updateBackfillState,
  getBackfillState,
} from "@/app/ingestors/discord/services/backfill-state";
import type { SchedulerJobMessage } from "@/app/ingestors/discord/services/backfill-types";
import { logDiscordRequest } from "./interruptors";
import {
  startGateway,
  stopGateway,
  getGatewayStatus,
} from "./services/gateway-service";

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

const gatewayStartRoute = route("/gateway/start", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      await startGateway();

      const apiResponse = Response.json({
        success: true,
        message: "Gateway connection started",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord Gateway start error:", error);
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

const gatewayStopRoute = route("/gateway/stop", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      await stopGateway();

      const apiResponse = Response.json({
        success: true,
        message: "Gateway connection stopped",
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord Gateway stop error:", error);
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

const gatewayStatusRoute = route("/gateway/status", [
  logDiscordRequest,
  async ({ request, ctx }: { request: Request; ctx: any }) => {
    try {
      const status = await getGatewayStatus();

      const apiResponse = Response.json({
        success: true,
        status,
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord Gateway status error:", error);
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
  gatewayStartRoute,
  gatewayStopRoute,
  gatewayStatusRoute,
];
