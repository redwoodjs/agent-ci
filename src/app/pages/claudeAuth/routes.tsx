import { route } from "rwsdk/router";
import {
  generateOAuthURL,
  exchangeCodeForTokens,
  getStoredTokens,
  deleteUserTokens,
} from "@/app/pages/claudeAuth/claude-oauth";

import { listChatProcessIds } from "@/app/pages/chat/actions";
import { ClaudeModel, isClaudeModel } from "@/types/claude";

import { sendAndStreamClaudeMessage } from "@/app/pages/chat/components/action";

// Helper function to extract user ID from session cookie
export function getUserIdFromCookie(request: Request): string | null {
  const cookies = request.headers.get("Cookie") || "";
  const sessionMatch = cookies.match(/claude_session=([^;]+)/);
  return sessionMatch?.[1] || null;
}

// Helper function to generate a session ID (matching existing pattern)
function generateSessionId(): string {
  return Math.random().toString(36).substring(7);
}

export const claudeAuthRoutes = [
  // Start OAuth login flow
  route("/login", async ({ request }) => {
    try {
      const { url, state } = await generateOAuthURL();

      console.log("Generated OAuth URL:", url);
      console.log("State for this request:", state);

      return new Response(null, {
        status: 302,
        headers: {
          Location: url,
        },
      });
    } catch (err) {
      const error = err as Error;
      console.error("OAuth URL generation error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),

  // Handle OAuth callback and exchange code for tokens
  route("/exchange", async ({ request }) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const body = (await request.json()) as { code?: string };
      const { code } = body || {};

      if (!code) {
        return new Response(JSON.stringify({ error: "Missing code" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Generate a session ID for this user
      const userId = generateSessionId();

      const tokens = await exchangeCodeForTokens(code, userId);

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `claude_session=${userId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`, // 1 week
        },
      });
    } catch (err) {
      const error = err as Error;
      console.error("OAuth exchange error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),

  // Check authentication status
  route("/status", async ({ request }) => {
    const userId = getUserIdFromCookie(request);

    if (!userId) {
      return new Response(JSON.stringify({ authenticated: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const tokens = await getStoredTokens(userId);
      return new Response(
        JSON.stringify({
          authenticated: !!tokens,
          expires_at: tokens?.expires_at,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      const error = err as Error;
      console.error("Auth status check error:", error);
      return new Response(JSON.stringify({ authenticated: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }
  }),

  // Send message to Claude via container CLI (with streaming)
  route("/chat", async ({ request }) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const userId = getUserIdFromCookie(request);

    if (!userId) {
      return new Response(JSON.stringify({ error: "No session" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const body = (await request.json()) as {
        message?: string;
        containerId?: string;
        model?: unknown;
      };
      const { message, containerId } = body || {};
      const requestedModel = body?.model;

      if (!containerId) {
        return new Response(JSON.stringify({ error: "Missing containerId" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      let model: ClaudeModel = "default";
      if (requestedModel !== undefined) {
        if (!isClaudeModel(requestedModel)) {
          return new Response(JSON.stringify({ error: "Invalid model" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        model = requestedModel;
      }

      // Start the Claude CLI process in the container

      const result = await sendAndStreamClaudeMessage(
        containerId,
        message || "",
        model
      );

      return new Response(
        JSON.stringify({
          success: true,
          processId: result.id,
          containerId,
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    } catch (err) {
      const error = err as Error;
      console.error("Chat error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),

  // List prior chat processIds for a container
  route("/chats/:containerId", async ({ params, request }) => {
    try {
      const { containerId } = params;
      const ids = await listChatProcessIds(containerId, 50);
      return new Response(JSON.stringify({ processIds: ids }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      const error = err as Error;
      console.error("List chats error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),

  // Stream process output from container
  route("/stream/:containerId/:processId", async ({ params }) => {
    // try {
    //   const { containerId, processId } = params;
    //   const stream = await streamProcess(containerId, processId);

    //   return new Response(stream, {
    //     headers: {
    //       "Content-Type": "text/plain; charset=utf-8",
    //       "Cache-Control": "no-cache",
    //       Connection: "keep-alive",
    //     },
    //   });
    // } catch (err) {
    // const error = err as Error;
    // console.error("Stream error:", error);
    return new Response(JSON.stringify({ error: "cry" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
    // }
  }),

  // Logout and clear tokens
  route("/logout", async ({ request }) => {
    const userId = getUserIdFromCookie(request);

    if (userId) {
      try {
        await deleteUserTokens(userId);
      } catch (err) {
        const error = err as Error;
        console.error("Logout error:", error);
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": `claude_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, // Clear cookie
      },
    });
  }),
];
