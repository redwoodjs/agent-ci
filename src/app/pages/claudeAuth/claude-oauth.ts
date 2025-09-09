import { createHash, randomBytes } from "crypto";
import { db } from "@/db";


// Generate PKCE code verifier and challenge
function generatePKCE() {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  return { codeVerifier, codeChallenge };
}

// Clean up expired PKCE states
async function cleanupExpiredStates(): Promise<void> {
  const now = new Date().toISOString();
  await db
    .deleteFrom("oauth_state")
    .where("expires_at", "<", now)
    .execute();
}

export async function generateOAuthURL() {
  const { codeVerifier, codeChallenge } = generatePKCE();

  // Use the verifier as the state (like opencode does)
  const state = codeVerifier;

  // Clean up expired states first
  await cleanupExpiredStates();

  // Store verifier in database with 10-minute expiry
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db
    .insertInto("oauth_state")
    .values({
      state,
      code_verifier: codeVerifier,
      expires_at: expiresAt,
    })
    .execute();

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
  userId: string,
) {
  // Split the code - opencode expects format: code#state
  const splits = code.includes("#") ? code.split("#") : [code, ""];
  const actualCode = splits[0];
  const state = splits[1] || "";

  // Get the PKCE verifier from database
  const stateRecord = await db
    .selectFrom("oauth_state")
    .select(["code_verifier"])
    .where("state", "=", state)
    .executeTakeFirst();

  if (!stateRecord) {
    throw new Error(`No PKCE verifier found for state: ${state}`);
  }

  const codeVerifier = stateRecord.code_verifier;

  const requestBody = {
    code: actualCode,
    state: state,
    grant_type: "authorization_code",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    redirect_uri: "https://console.anthropic.com/oauth/code/callback",
    code_verifier: codeVerifier,
  };

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
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  const tokens = await response.json();

  // Store tokens directly (no encryption implemented yet)
  
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Store tokens in database (upsert)
  await db
    .insertInto("oauth_tokens")
    .values({
      id: crypto.randomUUID(),
      user_id: userId,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scope: tokens.scope || "org:create_api_key user:profile user:inference",
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc
      .column("user_id")
      .doUpdateSet({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: expiresAt,
        scope: tokens.scope || "org:create_api_key user:profile user:inference",
        updated_at: now,
      })
    )
    .execute();

  // Clean up PKCE verifier
  await db
    .deleteFrom("oauth_state")
    .where("state", "=", state)
    .execute();

  return tokens;
}

export async function getStoredTokens(userId: string) {
  const tokenRecord = await db
    .selectFrom("oauth_tokens")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (!tokenRecord) {
    return null;
  }

  return {
    access_token: tokenRecord.access_token,
    refresh_token: tokenRecord.refresh_token,
    expires_at: new Date(tokenRecord.expires_at).getTime(),
    scope: tokenRecord.scope,
  };
}

export async function refreshAccessToken(userId: string) {
  const tokenRecord = await db
    .selectFrom("oauth_tokens")
    .selectAll()
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (!tokenRecord) {
    throw new Error("No tokens found for user");
  }

  const refreshToken = tokenRecord.refresh_token;

  const response = await fetch("https://console.anthropic.com/v1/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const tokens = await response.json();

  // Update stored tokens
  
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  await db
    .updateTable("oauth_tokens")
    .set({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || refreshToken,
      expires_at: expiresAt,
      updated_at: now,
    })
    .where("user_id", "=", userId)
    .execute();

  return tokens;
}

export async function getValidAccessToken(userId: string) {
  const stored = await getStoredTokens(userId);
  if (!stored) {
    return null;
  }

  // Check if token is expired (with 5 minute buffer)
  if (Date.now() > stored.expires_at - 300000) {
    try {
      await refreshAccessToken(userId);
      const refreshedStored = await getStoredTokens(userId);
      return refreshedStored?.access_token || null;
    } catch (error) {
      console.error("Failed to refresh token:", error);
      return null;
    }
  }

  return stored.access_token;
}


export async function deleteUserTokens(userId: string): Promise<void> {
  await db
    .deleteFrom("oauth_tokens")
    .where("user_id", "=", userId)
    .execute();
}