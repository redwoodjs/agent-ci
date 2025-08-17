import { route } from "rwsdk/router";

import {
  generateOAuthURL,
  exchangeCodeForTokens,
  makeClaudeRequest,
  getStoredTokens,
} from "@/claude-oauth";

import { fetchContainer } from "@/container";

export const apiRoutes = [
  // OAuth routes
  route("/auth/claude/login", async ({ request }) => {
    const { url, state } = generateOAuthURL();

    console.log("Generated OAuth URL:", url);
    console.log("State for this request:", state);

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
      },
    });
  }),

  route("/auth/claude/exchange", async ({ request }) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const baseURL = `${url.protocol}//${url.host}`;

    try {
      const { code } = await request.json<{ code: string }>();

      if (!code) {
        return new Response(JSON.stringify({ error: "Missing code" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      // Generate a session ID for this exchange
      const sessionId = Math.random().toString(36).substring(7);

      const tokens = await exchangeCodeForTokens(code, sessionId, baseURL);

      // Credentials will be injected into specific containers when they're accessed
      // via the /api/containers/:containerId/setup-credentials endpoint

      return new Response(JSON.stringify({ success: true }), {
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": `claude_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        },
      });
    } catch (error) {
      console.error("OAuth exchange error:", error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }),

  route("/claude/query", async ({ request }) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const cookies = request.headers.get("Cookie") || "";
    const sessionMatch = cookies.match(/claude_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];

    if (!sessionId) {
      return new Response(JSON.stringify({ error: "No session" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const { message } = await request.json<{ message: string }>();
      const response = await makeClaudeRequest(sessionId, [
        { role: "user", content: message },
      ]);

      return new Response(JSON.stringify(response), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Claude query error:", error);
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }),

  route("/auth/status", async ({ request }) => {
    const cookies = request.headers.get("Cookie") || "";
    const sessionMatch = cookies.match(/claude_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];

    if (!sessionId) {
      return new Response(JSON.stringify({ authenticated: false }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const tokens = getStoredTokens(sessionId);
    return new Response(
      JSON.stringify({
        authenticated: !!tokens,
        expires_at: tokens?.expires_at,
      }),
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  }),

  route("/containers/:containerId/tty/output", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = "/tty/output";
    // Preserve query parameters (like processId)
    url.search = new URL(request.url).search;

    const response = await fetchContainer({
      containerId: params.containerId,
      request: new Request(url, request),
    });
    return response;
  }),

  route(
    "/containers/:containerId/setup-credentials",
    async ({ request, params }) => {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const containerId = params.containerId;
      const cookies = request.headers.get("Cookie") || "";
      const sessionMatch = cookies.match(/claude_session=([^;]+)/);
      const sessionId = sessionMatch?.[1];

      if (!sessionId) {
        return new Response(JSON.stringify({ error: "No session" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      const tokens = getStoredTokens(sessionId);
      if (!tokens) {
        return new Response(JSON.stringify({ error: "No tokens found" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        // Send credentials to the specific container
        const credentialsRequest = new Request(
          `http://localhost:8911/claude/credentials`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: tokens.expires_at,
            }),
          }
        );

        const response = await fetchContainer({
          containerId,
          request: credentialsRequest,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Container credential setup failed: ${response.status} - ${errorText}`
          );
        }

        const result = await response.json();
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (error) {
        console.error("Failed to setup credentials in container:", error);
        return new Response(
          JSON.stringify({
            error: "Failed to setup credentials in container",
            details: error instanceof Error ? error.message : "Unknown error",
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }
  ),

  route("/containers/:containerId/tty/exec", async ({ request, params }) => {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const containerId = params.containerId;

    try {
      // Forward the TTY exec request to the specific container
      const body = await request.text();

      const ttyRequest = new Request(`http://localhost:8911/tty/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body,
      });

      const response = await fetchContainer({
        containerId,
        request: ttyRequest,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Container TTY exec failed: ${response.status} - ${errorText}`
        );
      }

      const result = await response.text();
      return new Response(result, {
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      console.error("Failed to execute TTY command in container:", error);
      return new Response(
        JSON.stringify({
          error: "Failed to execute command in container",
          details: error instanceof Error ? error.message : "Unknown error",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }),
];
