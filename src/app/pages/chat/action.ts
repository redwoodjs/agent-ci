"use server";

import { env } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import { getValidAccessToken } from "@/app/pages/claudeAuth/claude-oauth";
import { getTaskByContainerId } from "@/app/pages/task/actions";

export async function sendAuthenticatedMessage(
  containerId: string,
  userId: string,
  message: string
) {
  const sandbox = await getSandbox(env.Sandbox, containerId);

  // First, ensure OAuth credentials are set up in the container
  await setupContainerCredentials(containerId, userId);

  // Get the task's lane-id to use as session-id
  const task = await getTaskByContainerId(containerId);

  let sessionFlag = `--session-id \\"${task.laneId}\\"`;
  const { files } = await sandbox.listFiles(
    "/root/.claude/projects/-workspace/"
  );
  if (files.filter((file) => file.name.startsWith(task.laneId)).length > 0) {
    // Here we might want to use "--continue" instead of "--resume"
    sessionFlag = `--resume \\"${task.laneId}\\"`;
  }

  // Escape quotes in the message for shell execution
  const escapedMessage = message.replace(/"/g, '\\"');

  if (!task?.laneId) {
    console.log(task);
    throw new Error("Task does not have a lane id");
  }

  // Execute Claude CLI command with streaming output from workspace directory, using lane-id as session-id
  const process = await sandbox.startProcess(
    `bash -c "cd /workspace && IS_SANDBOX=1 claude --dangerously-skip-permissions --model sonnet --output-format stream-json --verbose ${sessionFlag} --print \\"${escapedMessage}\\""`
  );

  return { id: process.id };
}

export async function streamProcess(containerId: string, processId: string) {
  const sandbox = await getSandbox(env.Sandbox, containerId);
  return await sandbox.streamProcessLogs(processId);
}

// Function to setup OAuth credentials in a container
export async function setupContainerCredentials(
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
