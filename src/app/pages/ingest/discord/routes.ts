import { route } from "rwsdk/router";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { ingestDiscordMessages } from "@/app/ingestors/discord/fetch";
import { parseDiscordFromR2 } from "@/app/ingestors/discord/parse";

const fetchRequestSchema = z.object({
  guildID: z.string().min(1).default("679514959968993311"),
  channelID: z.string().min(1).default("1307974274145062912"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

async function validateFetchRequest({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  try {
    let data = {};
    try {
      data = await request.json();
    } catch {
      // Empty body is OK, we have defaults
    }
    const validated = fetchRequestSchema.parse(data);

    if (validated.date && (validated.startDate || validated.endDate)) {
      return Response.json(
        {
          success: false,
          error: "Cannot specify both 'date' and 'startDate/endDate'",
        },
        { status: 400 }
      );
    }

    if (
      (validated.startDate && !validated.endDate) ||
      (!validated.startDate && validated.endDate)
    ) {
      return Response.json(
        {
          success: false,
          error: "Both 'startDate' and 'endDate' must be specified together",
        },
        { status: 400 }
      );
    }

    ctx.validatedData = validated;
    return ctx;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          success: false,
          error: "Validation failed",
          details: error.issues,
        },
        { status: 400 }
      );
    }
    return Response.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }
}

async function logDiscordRequest({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  const start = Date.now();
  const url = new URL(request.url);

  console.log(`Discord API: ${request.method} ${url.pathname}`);

  ctx.logCompletion = (response: Response) => {
    const duration = Date.now() - start;
    console.log(
      `Discord API: ${request.method} ${url.pathname} - ${response.status} (${duration}ms)`
    );
  };

  return ctx;
}

const fetchRoute = route("/fetch", [
  logDiscordRequest,
  validateFetchRequest,
  async ({ ctx }: { ctx: any }) => {
    try {
      const { guildID, channelID, date, startDate, endDate } =
        ctx.validatedData;

      console.log(`Ingesting Discord messages for channel ${channelID}`);

      const result = await ingestDiscordMessages({
        guildID,
        channelID,
        date,
        startDate,
        endDate,
      });

      const apiResponse = Response.json({
        success: true,
        ...result,
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord ingestion error:", error);
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

const parseRequestSchema = z.object({
  key: z.string().min(1),
});

async function validateParseRequest({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  try {
    const data = await request.json();
    const validated = parseRequestSchema.parse(data);
    ctx.validatedData = validated;
    return ctx;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return Response.json(
        {
          success: false,
          error: "Validation failed",
          details: error.issues,
        },
        { status: 400 }
      );
    }
    return Response.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 }
    );
  }
}

const parseRoute = route("/parse", [
  logDiscordRequest,
  validateParseRequest,
  async ({ ctx }: { ctx: any }) => {
    try {
      const { key } = ctx.validatedData;

      console.log(`Parsing Discord file from R2: ${key}`);

      const transcript = await parseDiscordFromR2(env.MACHINEN_BUCKET, key);

      const apiResponse = Response.json({
        success: true,
        key,
        lines: transcript.length,
        transcript,
      });
      ctx.logCompletion?.(apiResponse);
      return apiResponse;
    } catch (error) {
      console.error("Discord parse error:", error);
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

export const routes = [fetchRoute, parseRoute];
