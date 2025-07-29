import { createHash, randomBytes } from "crypto";

// In-memory token storage (simple POC)
const tokenStore = new Map<
  string,
  {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  }
>();

// Generate PKCE code verifier and challenge
function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

// Store PKCE verifier temporarily (in production, use session storage)
const pkceStore = new Map<string, string>();

export function generateOAuthURL() {
  const { codeVerifier, codeChallenge } = generatePKCE();

  // Use the verifier as the state (like opencode does)
  const state = codeVerifier;

  // Store verifier for later use with state as key
  pkceStore.set(state, codeVerifier);

  const params = new URLSearchParams({
    code: "true",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    response_type: "code",
    redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    scope: "org:create_api_key user:profile user:inference",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state: state,
  });

  return {
    url: `https://claude.ai/oauth/authorize?${params.toString()}`,
    state: state,
  };
}

export async function exchangeCodeForTokens(
  code: string,
  sessionId: string,
  baseURL: string,
) {
  // Split the code - opencode expects format: code#state
  const splits = code.includes("#") ? code.split("#") : [code, ""];
  const actualCode = splits[0];
  const state = splits[1] || "";

  // Get the PKCE verifier using the state
  const codeVerifier = pkceStore.get(state);
  if (!codeVerifier) {
    throw new Error(`No PKCE verifier found for state: ${state}`);
  }

  console.log("Full code received:", code);
  console.log(
    "Split result - actualCode:",
    actualCode.substring(0, 20) + "...",
    "state:",
    state,
  );
  console.log("Looking for verifier with state:", state);
  console.log("Available states in pkceStore:", Array.from(pkceStore.keys()));

  console.log("Exchanging tokens with:", {
    actualCode: actualCode.substring(0, 10) + "...",
    state: state,
    sessionId,
    baseURL,
    codeVerifier: codeVerifier
      ? codeVerifier.substring(0, 10) + "..."
      : "NOT_FOUND",
  });

  const requestBody = {
    code: actualCode,
    state: state,
    grant_type: "authorization_code",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    code_verifier: codeVerifier,
  };

  console.log("Token exchange request body:", requestBody);

  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Token exchange failed:");
    console.error("Status:", response.status);
    console.error("Response:", errorText);
    console.error("Request was:", requestBody);
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  const tokens = await response.json();

  console.log("Received tokens:", {
    access_token: tokens.access_token
      ? tokens.access_token.substring(0, 20) + "..."
      : "MISSING",
    refresh_token: tokens.refresh_token
      ? tokens.refresh_token.substring(0, 20) + "..."
      : "MISSING",
    expires_in: tokens.expires_in,
    token_type: tokens.token_type,
    scope: tokens.scope,
  });

  // Store tokens in memory
  tokenStore.set(sessionId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  });

  // Clean up PKCE verifier
  pkceStore.delete(state);

  return tokens;
}

export function getStoredTokens(sessionId: string) {
  return tokenStore.get(sessionId);
}

export async function refreshAccessToken(sessionId: string) {
  const stored = tokenStore.get(sessionId);
  if (!stored || !stored.refresh_token) {
    throw new Error("No refresh token available");
  }

  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: stored.refresh_token,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokens = await response.json();

  // Update stored tokens
  tokenStore.set(sessionId, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || stored.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
  });

  return tokens;
}

export async function getValidAccessToken(sessionId: string) {
  const stored = tokenStore.get(sessionId);
  if (!stored) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() > stored.expires_at - 300000) {
    try {
      await refreshAccessToken(sessionId);
      return tokenStore.get(sessionId)?.access_token || null;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      return null;
    }
  }

  return stored.access_token;
}

export async function makeClaudeRequest(sessionId: string, messages: any[]) {
  const accessToken = await getValidAccessToken(sessionId);
  if (!accessToken) {
    throw new Error("No valid access token available");
  }

  console.log(
    "Using OAuth token for Claude Code API:",
    accessToken.substring(0, 20) + "...",
  );

  // Match exactly what Claude Code sends with OAuth (no x-api-key involved)
  const headers = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "@ai-sdk/anthropic:1.2.12",
    authorization: `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  };

  console.log("Claude Code API headers:", headers);

  const body = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages,
  };

  // Use the standard Anthropic Messages API endpoint
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  console.log("Claude Code API response status:", response.status);

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Claude Code API error:", errorText);
    throw new Error(`API call failed: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  console.log("Claude Code API success:", result);

  return result;
}