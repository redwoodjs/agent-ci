import { defineApp } from "rwsdk/worker";
import { route, render } from "rwsdk/router";
import { Document } from "@/app/Document";

import { EditorPage } from "@/app/pages/editor/EditorPage";
import { TermPage } from "@/app/pages/TermPage";
import { ClaudePocPage } from "@/app/pages/claude-poc/ClaudePocPage";
import { ClaudePage } from "@/app/pages/claude/ClaudePage";
import { fetchContainer } from "./container";
import { SessionPage } from "./app/pages/session/SessionPage";
import { 
  generateOAuthURL, 
  exchangeCodeForTokens, 
  makeClaudeRequest, 
  getStoredTokens 
} from "./claude-oauth";

export { MachinenContainer } from "./container";

export default defineApp([
  render(Document, [
    route("/", () => {
      return <SessionPage />;
    }),
    route("/claude-poc", ClaudePocPage),
    route("/claude", ClaudePage),
    route("/claude/:containerId", ClaudePage),
    // this will be the container id.
    route("/editor/:containerId", EditorPage),
    route("/editor/:containerId/*", EditorPage),
    route("/term/:containerId", TermPage),
  ]),

  route("/preview/:containerId*", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/preview/${params.containerId}`, "");

    const headers = new Headers(request.headers);
    const internalQuery = url.searchParams.get("__x_internal_query");
    if (internalQuery) {
      const originalQuery = decodeURIComponent(internalQuery);
      url.search = originalQuery ? "?" + originalQuery : "";
      url.searchParams.delete("__x_internal_query");
    }

    if (headers.has("x-websocket-protocol")) {
      console.log(
        `Renaming 'x-websocket-protocol' to 'sec-websocket-protocol' for ${request.url}`
      );
      headers.set(
        "sec-websocket-protocol",
        headers.get("x-websocket-protocol")!
      );
      headers.delete("x-websocket-protocol");
    }
    const requestInit: RequestInit = {
      method: request.method,
      body: request.body ? request.body : undefined,
      redirect: request.redirect,
    };

    return fetchContainer({
      id: params.containerId,
      request: new Request(url, requestInit),
      port: "8910",
    });
  }),

  route("/tty/:containerId/attach", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(`/tty/${params.containerId}`, "/tty");

    const response = await fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
    });
    return response;
  }),

  route("/api/containers/:containerId/tty/output", async ({ request, params }) => {
    const url = new URL(request.url);
    url.pathname = "/tty/output";
    // Preserve query parameters (like processId)
    url.search = new URL(request.url).search;

    const response = await fetchContainer({
      id: params.containerId,
      request: new Request(url, request),
    });
    return response;
  }),

  route("/api/containers/:containerId/debug", async ({ request, params }) => {
    const containerId = params.containerId;
    
    try {
      // Test command to see container info
      const debugCommand = "pwd && ls -la && echo 'CONTAINER_DEBUG_ID:' && hostname";
      
      const debugRequest = new Request(`http://localhost:8911/tty/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: debugCommand }),
      });

      const response = await fetchContainer({
        id: containerId,
        request: debugRequest,
      });

      if (!response.ok) {
        throw new Error(`Debug failed: ${response.status}`);
      }

      const result = await response.text();
      console.log(`🔍 CONTAINER DEBUG for ${containerId}:`, result);
      
      return new Response(JSON.stringify({ 
        containerId,
        debugOutput: result 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error(`❌ DEBUG FAILED for container ${containerId}:`, error);
      return new Response(JSON.stringify({ 
        error: "Debug failed",
        details: error instanceof Error ? error.message : "Unknown error"
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }),

  // OAuth routes
  route("/api/auth/claude/login", async ({ request }) => {
    const { url, state } = generateOAuthURL();
    
    console.log('Generated OAuth URL:', url);
    console.log('State for this request:', state);
    
    return new Response(null, {
      status: 302,
      headers: {
        'Location': url,
      },
    });
  }),

  route("/api/auth/claude/exchange", async ({ request }) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    
    const url = new URL(request.url);
    const baseURL = `${url.protocol}//${url.host}`;
    
    try {
      const { code } = await request.json();
      
      if (!code) {
        return new Response(JSON.stringify({ error: 'Missing code' }), { 
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Generate a session ID for this exchange
      const sessionId = Math.random().toString(36).substring(7);
      
      const tokens = await exchangeCodeForTokens(code, sessionId, baseURL);
      
      // Credentials will be injected into specific containers when they're accessed
      // via the /api/containers/:containerId/setup-credentials endpoint
      
      return new Response(JSON.stringify({ success: true }), {
        headers: { 
          'Content-Type': 'application/json',
          'Set-Cookie': `claude_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax`,
        }
      });
    } catch (error) {
      console.error('OAuth exchange error:', error);
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }),

  route("/api/claude/query", async ({ request }) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    
    const cookies = request.headers.get('Cookie') || '';
    const sessionMatch = cookies.match(/claude_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];
    
    if (!sessionId) {
      return new Response(JSON.stringify({ error: 'No session' }), { 
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    try {
      const { message } = await request.json();
      const response = await makeClaudeRequest(sessionId, [
        { role: 'user', content: message }
      ]);
      
      return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Claude query error:', error);
      return new Response(JSON.stringify({ error: error.message }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }),

  route("/api/auth/status", async ({ request }) => {
    const cookies = request.headers.get('Cookie') || '';
    const sessionMatch = cookies.match(/claude_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];
    
    if (!sessionId) {
      return new Response(JSON.stringify({ authenticated: false }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const tokens = getStoredTokens(sessionId);
    return new Response(JSON.stringify({ 
      authenticated: !!tokens,
      expires_at: tokens?.expires_at 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }),

  route("/api/containers/:containerId/setup-credentials", async ({ request, params }) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const containerId = params.containerId;
    const cookies = request.headers.get('Cookie') || '';
    const sessionMatch = cookies.match(/claude_session=([^;]+)/);
    const sessionId = sessionMatch?.[1];
    
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "No session" }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const tokens = getStoredTokens(sessionId);
    if (!tokens) {
      return new Response(JSON.stringify({ error: "No tokens found" }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    try {
      // Send credentials to the specific container
      const credentialsRequest = new Request(`http://localhost:8911/claude/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_at,
        }),
      });

      const response = await fetchContainer({
        id: containerId,
        request: credentialsRequest,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Container credential setup failed: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      return new Response(JSON.stringify(result), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error('Failed to setup credentials in container:', error);
      return new Response(JSON.stringify({ 
        error: "Failed to setup credentials in container",
        details: error instanceof Error ? error.message : "Unknown error"
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }),

  route("/api/containers/:containerId/tty/exec", async ({ request, params }) => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const containerId = params.containerId;
    
    try {
      // Forward the TTY exec request to the specific container
      const body = await request.text();
      const command = JSON.parse(body).command;
      
      console.log(`🚀 CLAUDE EXEC DEBUG: Container ${containerId}, Command: ${command}`);
      
      const ttyRequest = new Request(`http://localhost:8911/tty/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });

      const response = await fetchContainer({
        id: containerId,
        request: ttyRequest,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Container TTY exec failed: ${response.status} - ${errorText}`);
      }

      const result = await response.text();
      console.log(`✅ CLAUDE EXEC SUCCESS: Container ${containerId}`);
      return new Response(result, {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (error) {
      console.error(`❌ CLAUDE EXEC FAILED: Container ${containerId}:`, error);
      return new Response(JSON.stringify({ 
        error: "Failed to execute command in container",
        details: error instanceof Error ? error.message : "Unknown error"
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }),
]);
