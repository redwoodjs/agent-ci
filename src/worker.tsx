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
    route("/claude/:sessionId", ClaudePage),
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
      
      // Create credentials file in container
      try {
        const credentialsResponse = await fetch('http://localhost:8911/claude/credentials', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: Date.now() + tokens.expires_in * 1000,
          }),
        });
        
        if (!credentialsResponse.ok) {
          console.error('Failed to create credentials file in container');
        } else {
          console.log('Claude credentials created in container');
        }
      } catch (error) {
        console.error('Error creating credentials in container:', error);
      }
      
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
]);
