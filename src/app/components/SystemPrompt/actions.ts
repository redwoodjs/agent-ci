"use server";

import { getSandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import { getValidAccessToken } from "@/claude-oauth";
import { getTaskByContainerId } from "@/app/pages/task/actions";

export async function resetSessionWithSystemPrompt(containerId: string, userId: string) {
  // Get the task and its system prompt
  const task = await getTaskByContainerId(containerId);
  
  if (!task) {
    throw new Error("Task not found");
  }

  // Reset the Claude session with the task's system prompt
  return await resetClaudeSession(
    containerId, 
    userId, 
    task.systemPrompt || undefined
  );
}

async function resetClaudeSession(
  containerId: string,
  userId: string,
  systemPrompt?: string
) {
  const sandbox = await getSandbox(env.Sandbox, containerId);

  try {
    // First, ensure OAuth credentials are set up in the container
    await setupContainerCredentials(containerId, userId);

    // Kill any existing Claude processes to ensure clean state
    await sandbox.exec("pkill -f claude || true");
    
    // Wait a moment for processes to terminate
    await new Promise(resolve => setTimeout(resolve, 500));

    // Clear any existing Claude history/cache by removing the workspace project history
    await sandbox.exec("cd /workspace");
    
    // Start a fresh Claude session with /clear command to reset context
    const clearCommand = `claude --continue --model sonnet --output-format stream-json --verbose --print "/clear"`;
    const clearProcess = await sandbox.startProcess(clearCommand);
    
    // Wait for clear command to complete
    await new Promise(resolve => setTimeout(resolve, 1000));

    // If we have a system prompt, start a new session with it
    if (systemPrompt) {
      const escapedSystemPrompt = systemPrompt.replace(/"/g, '\\"');
      const initMessage = "Session reset with new system prompt applied.";
      const escapedMessage = initMessage.replace(/"/g, '\\"');
      
      const process = await sandbox.startProcess(
        `claude --continue --model sonnet --output-format stream-json --verbose --append-system-prompt "${escapedSystemPrompt}" --print "${escapedMessage}"`
      );
      
      return { 
        success: true, 
        processId: process.id,
        message: "Session reset with system prompt applied" 
      };
    } else {
      return { 
        success: true, 
        processId: clearProcess.id,
        message: "Session reset, no system prompt applied" 
      };
    }
  } catch (error) {
    console.error(`Failed to reset Claude session for container ${containerId}:`, error);
    throw error;
  }
}

// Function to setup OAuth credentials in a container
async function setupContainerCredentials(
  containerId: string,
  userId: string
) {
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
        numStartups: 0,
        installMethod: "oauth",
        autoUpdates: true,
        firstStartTime: new Date().toISOString(),
        hasCompletedOnboarding: true,
        projects: {
          "/workspace": {
            allowedTools: ["*"],
            history: [],
            hasTrustDialogAccepted: true,
          },
        },
      };
    }

    // Add OAuth credentials to the configuration
    claudeConfig.oauthAccessToken = accessToken;
    claudeConfig.apiKeySource = "oauth";

    // Write the updated configuration back
    await sandbox.writeFile(
      claudeConfigPath,
      JSON.stringify(claudeConfig, null, 2)
    );

    // Create credentials file that matches the old implementation format
    const credentialsConfig = {
      claudeAiOauth: {
        accessToken: accessToken,
        refreshToken: "placeholder-refresh", // We'll need to store this properly later
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      },
    };
    await sandbox.writeFile(
      `${claudeDir}/.credentials.json`,
      JSON.stringify(credentialsConfig, null, 2)
    );

    // Copy settings.json to ensure proper permissions
    const settingsConfig = {
      permissions: {
        defaultMode: "acceptEdits",
        allow: [
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
          "Write(*)",
        ],
      },
    };
    await sandbox.writeFile(
      `${claudeDir}/settings.json`,
      JSON.stringify(settingsConfig, null, 2)
    );

    console.log(
      `Successfully set up OAuth credentials for container ${containerId}`
    );
    return { success: true };
  } catch (error) {
    console.error(
      `Failed to setup credentials for container ${containerId}:`,
      error
    );
    throw error;
  }
}