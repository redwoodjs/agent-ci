import * as vscode from "vscode";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as child_process from "child_process";
import { convertPbToMarkdown } from "./protobugConverter";

/**
 * Interface for Antigravity Context
 */
export interface AntigravityContext {
  projectId: string;
  projectPath: string;
}

/**
 * Identify if we are in an Antigravity context and return project info
 */
export async function identifyAntigravityContext(logger: vscode.OutputChannel): Promise<AntigravityContext | null> {
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (!homeDir) {
    logger.appendLine("[Antigravity] Home directory not found.");
    return null;
  }

  const antiraDir = vscode.Uri.file(path.join(homeDir, ".gemini", "antigravity", "brain"));
  const workspaces = vscode.workspace.workspaceFolders;
  if (!workspaces || workspaces.length === 0) {
    logger.appendLine("[Antigravity] No active workspace folders found.");
    return null;
  }

  const activeWorkspacePath = workspaces[0].uri.fsPath;
  logger.appendLine(`[Antigravity] Searching for project associated with ${activeWorkspacePath}`);

  try {
    const projects = await vscode.workspace.fs.readDirectory(antiraDir);
    for (const [name, type] of projects) {
      if (type === vscode.FileType.Directory) {
        const projectPath = vscode.Uri.joinPath(antiraDir, name);
        const projectFiles = await vscode.workspace.fs.readDirectory(projectPath);
        
        for (const [fileName, fileType] of projectFiles) {
          if (fileType === vscode.FileType.File && (fileName === "implementation_plan.md" || fileName === "task.md")) {
            const content = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(projectPath, fileName));
            const text = Buffer.from(content).toString("utf8");
            
            if (text.includes(activeWorkspacePath)) {
              logger.appendLine(`[Antigravity] Identified matching project: ${name}`);
              return { projectId: name, projectPath: projectPath.fsPath };
            }
          }
        }
      }
    }
  } catch (error) {
    logger.appendLine(`[Antigravity] Error scanning project brain: ${error}`);
  }

  logger.appendLine("[Antigravity] No project identified for this workspace.");
  return null;
}

/**
 * Upload Antigravity artifacts and conversations to Machinen
 */
export async function uploadAntigravityData(
  context: vscode.ExtensionContext,
  projectId: string,
  projectPath: string,
  logger: vscode.OutputChannel,
  getApiUrl: () => string
) {
  const apiUrl = getApiUrl();
  const config = vscode.workspace.getConfiguration("machinen");
  const apiKey = config.get<string>("apiKey", "");

  if (!apiUrl || !apiKey) {
    vscode.window.showErrorMessage("Machinen API URL or API key not configured.");
    return;
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;
  const folderName = workspaceFolders?.[0].name || "unknown";
  
  let repo = "unknown";
  let branch = "unknown";
  try {
    const rootPath = workspaceFolders?.[0].uri.fsPath;
    if (rootPath) {
      repo = child_process.execSync("git remote get-url origin", { cwd: rootPath, encoding: "utf8" }).trim();
      branch = child_process.execSync("git rev-parse --abbrev-ref HEAD", { cwd: rootPath, encoding: "utf8" }).trim();
    }
  } catch (e) {
    logger.appendLine(`[Antigravity] Git info retrieval error: ${e}`);
  }

  const userHandle = process.env.USER || "agent";
  const stateKeyPrefix = `antigravity.lastUploadMtime.${projectId}`;
  let syncFailures = 0;

  // 1. Artifacts
  const artifacts = ["implementation_plan.md", "task.md", "walkthrough.md"];
  for (const fileName of artifacts) {
    const filePath = vscode.Uri.file(path.join(projectPath, fileName));
    try {
      const stat = await vscode.workspace.fs.stat(filePath);
      const lastUploadedMtime = context.globalState.get<number>(`${stateKeyPrefix}.${fileName}`, 0);

      if (stat.mtime > lastUploadedMtime) {
        logger.appendLine(`[Antigravity] Artifact ${fileName} has changed. Uploading...`);
        const content = await vscode.workspace.fs.readFile(filePath);
        const text = Buffer.from(content).toString("utf8");

        const payload = {
          r2Key: `agent/projects/${projectId}/${fileName}`,
          content: text,
          metadata: {
            title: fileName.replace(".md", "").replace("_", " "),
            author: userHandle,
            source: "antigravity",
            type: "artifact",
            repo, folder: folderName, branch
          }
        };

        const response = await postAgentIngest(payload, apiUrl, apiKey);
        if (response.success) {
          logger.appendLine(`[Antigravity] Artifact ${fileName} uploaded successfully.`);
          await context.globalState.update(`${stateKeyPrefix}.${fileName}`, stat.mtime);
        } else {
          logger.appendLine(`[Antigravity] Artifact ${fileName} upload failed: ${response.error}`);
          syncFailures++;
        }
      } else {
        logger.appendLine(`[Antigravity] Artifact ${fileName} is up to date.`);
      }
    } catch (e) {
      if (fileName !== "walkthrough.md") { // walkthrough is optional
        logger.appendLine(`[Antigravity] Skipping artifact ${fileName}: ${e}`);
      }
    }
  }

  // 2. Conversation (.pb file)
  try {
    const conversationsDir = vscode.Uri.file(path.join(path.dirname(path.dirname(projectPath)), "conversations"));
    const conversationFilePath = vscode.Uri.joinPath(conversationsDir, `${projectId}.pb`);
    
    try {
      const stat = await vscode.workspace.fs.stat(conversationFilePath);
      const lastUploadedMtime = context.globalState.get<number>(`${stateKeyPrefix}.conversation.pb`, 0);

      if (stat.mtime > lastUploadedMtime) {
        logger.appendLine(`[Antigravity] Conversation history ${projectId}.pb has changed. Uploading...`);
        const content = await vscode.workspace.fs.readFile(conversationFilePath);
        const markdownContent = convertPbToMarkdown(Buffer.from(content));

        const payload = {
          r2Key: `agent/projects/${projectId}/conversation.md`,
          content: markdownContent,
          metadata: {
            title: "Conversation History",
            author: userHandle,
            source: "antigravity",
            type: "conversation",
            repo, folder: folderName, branch
          }
        };

        const response = await postAgentIngest(payload, apiUrl, apiKey);
        if (response.success) {
          logger.appendLine(`[Antigravity] Conversation ${projectId}.pb uploaded successfully.`);
          await context.globalState.update(`${stateKeyPrefix}.conversation.pb`, stat.mtime);
        } else {
          logger.appendLine(`[Antigravity] Conversation ${projectId}.pb upload failed: ${response.error}`);
          syncFailures++;
        }
      } else {
        logger.appendLine(`[Antigravity] Conversation ${projectId}.pb is up to date.`);
      }
    } catch (e) {
      logger.appendLine(`[Antigravity] Conversation history for ${projectId} not found.`);
    }
  } catch (error) {
    logger.appendLine(`[Antigravity] Error in conversation upload: ${error}`);
  }

  if (syncFailures > 0) {
    vscode.window.showErrorMessage(`Antigravity data sync for project ${projectId} completed with ${syncFailures} failure(s). Check output for details.`);
  } else {
    vscode.window.showInformationMessage(`Antigravity data sync for project ${projectId} completed successfully.`);
  }
}

async function postAgentIngest(payload: any, apiUrl: string, apiKey: string): Promise<{ success: boolean; error?: string }> {
  const endpoint = `${apiUrl.replace(/\/$/, "")}/api/ingestors/agent/conversation`;
  
  try {
    const url = new URL(endpoint);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
    };

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const client = url.protocol === "https:" ? https : http;
      const req = client.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => body += chunk);
        res.on("end", () => resolve({ statusCode: res.statusCode || 500, body }));
      });
      req.on("error", reject);
      req.write(JSON.stringify(payload));
      req.end();
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { success: true };
    } else {
      return { success: false, error: `API Error ${response.statusCode}: ${response.body}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}
