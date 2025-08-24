"use server";

import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { getValidAccessToken } from "@/claude-oauth";


// Function to setup OAuth credentials in a container
export async function setupContainerCredentials(containerId: string, userId: string) {
  try {
    const accessToken = await getValidAccessToken(userId);
    if (!accessToken) {
      throw new Error("No valid access token available");
    }

    const sandbox = await getSandbox(env.Sandbox, containerId);
    
    // We're running as root, so Claude config should be in /root/.claude/
    const claudeDir = "/root/.claude";
    const claudeConfigPath = `${claudeDir}/.claude.json`;
    
    // Ensure the .claude directory exists
    await sandbox.exec(`mkdir -p ${claudeDir}`);
    
    // Read the current claude.json configuration and update it
    let claudeConfig;
    try {
      const existingConfig = await sandbox.readFile(claudeConfigPath);
      claudeConfig = JSON.parse(existingConfig);
    } catch {
      // If file doesn't exist, start with a basic config
      claudeConfig = {
        "numStartups": 0,
        "installMethod": "oauth",
        "autoUpdates": true,
        "firstStartTime": new Date().toISOString(),
        "hasCompletedOnboarding": true,
        "projects": {
          "/workspace": {
            "allowedTools": ["*"],
            "history": [],
            "hasTrustDialogAccepted": true
          }
        }
      };
    }

    // Add OAuth credentials to the configuration
    claudeConfig.oauthAccessToken = accessToken;
    claudeConfig.apiKeySource = "oauth";

    // Write the updated configuration back
    await sandbox.writeFile(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
    
    // Create credentials file that matches the old implementation format
    const credentialsConfig = {
      "claudeAiOauth": {
        "accessToken": accessToken,
        "refreshToken": "placeholder-refresh", // We'll need to store this properly later
        "expiresAt": Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        "scopes": ["org:create_api_key", "user:profile", "user:inference"]
      }
    };
    await sandbox.writeFile(`${claudeDir}/.credentials.json`, JSON.stringify(credentialsConfig, null, 2));
    
    // Copy settings.json to ensure proper permissions
    const settingsConfig = {
      "permissions": {
        "defaultMode": "acceptEdits",
        "allow": [
          "Agent(*)",
          "Bash(*)",
          "Edit(*)",
          "Glob(*)",
          "Grep(*)",
          "LS(*)",
          "MultiEdit(*)",
          "NotebookEdit(*)",
          "NotebookRead(*)",
          "Read(*)",
          "TodoRead(*)",
          "TodoWrite(*)",
          "WebFetch(*)",
          "WebSearch(*)",
          "Write(*)"
        ]
      }
    };
    await sandbox.writeFile(`${claudeDir}/settings.json`, JSON.stringify(settingsConfig, null, 2));
    
    
    console.log(`Successfully set up OAuth credentials for container ${containerId}`);
    return { success: true };
  } catch (error) {
    console.error(`Failed to setup credentials for container ${containerId}:`, error);
    throw error;
  }
}
