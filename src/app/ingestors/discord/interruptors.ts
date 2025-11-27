import { z } from "zod";
import { env } from "cloudflare:workers";

// Validation schema for Discord messages
const discordMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  author: z.object({
    id: z.string(),
    username: z.string(),
    global_name: z.string().optional(),
  }),
  channel_id: z.string(),
  message_reference: z
    .object({
      message_id: z.string(),
      channel_id: z.string(),
    })
    .optional(),
  thread: z
    .object({
      name: z.string(),
      message_count: z.number(),
      member_count: z.number(),
    })
    .optional(),
  reactions: z
    .array(
      z.object({
        emoji: z.object({
          name: z.string(),
        }),
        count: z.number(),
      })
    )
    .optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string(),
        size: z.number(),
        url: z.string(),
      })
    )
    .optional(),
  embeds: z
    .array(
      z.object({
        title: z.string().optional(),
        description: z.string().optional(),
        url: z.string().optional(),
      })
    )
    .optional(),
});

const discordConvertRequestSchema = z.object({
  messages: z.array(discordMessageSchema),
  guildId: z.string().optional(),
  channelId: z.string().optional(),
  exportTimestamp: z.string().optional(),
  splitConversations: z.boolean().optional(),
});

const discordBatchRequestSchema = z.object({
  files: z.array(discordConvertRequestSchema),
});

// Validation interruptor for Discord convert requests
export async function validateDiscordConvert({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  try {
    const data = await request.json();
    const validated = discordConvertRequestSchema.parse(data);
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

// Validation interruptor for Discord batch requests
export async function validateDiscordBatch({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  try {
    const data = await request.json();
    const validated = discordBatchRequestSchema.parse(data);
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

// Logging interruptor for Discord API calls
export async function logDiscordRequest({
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

// Rate limiting interruptor (basic implementation)
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export async function rateLimitDiscord({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  const clientIP = request.headers.get("CF-Connecting-IP") || "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute
  const maxRequests = 10; // 10 requests per minute

  const key = `discord:${clientIP}`;
  const current = requestCounts.get(key);

  if (!current || now > current.resetTime) {
    requestCounts.set(key, { count: 1, resetTime: now + windowMs });
    return ctx;
  }

  if (current.count >= maxRequests) {
    return Response.json(
      { success: false, error: "Rate limit exceeded" },
      { status: 429 }
    );
  }

  current.count++;
  return ctx;
}

// Webhook authentication interruptor
export async function requireWebhookAuth({
  request,
  ctx,
}: {
  request: Request;
  ctx: any;
}) {
  const authHeader = request.headers.get("Authorization");
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return Response.json(
      { success: false, error: "Missing or invalid Authorization header" },
      { status: 401 }
    );
  }

  const apiKey = authHeader.substring(7); // Remove "Bearer " prefix
  const expectedKey = (env as any).INGEST_API_KEY as string | undefined;

  if (!expectedKey) {
    console.error("INGEST_API_KEY is not set");
    return Response.json(
      { success: false, error: "Server configuration error" },
      { status: 500 }
    );
  }

  if (apiKey !== expectedKey) {
    return Response.json(
      { success: false, error: "Invalid API key" },
      { status: 401 }
    );
  }

  return ctx;
}
