import * as vscode from "vscode";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import * as childProcess from "child_process";


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

  const antigravityDir = vscode.Uri.file(path.join(homeDir, ".gemini", "antigravity", "brain"));
  const workspaces = vscode.workspace.workspaceFolders;
  if (!workspaces || workspaces.length === 0) {
    logger.appendLine("[Antigravity] No active workspace folders found.");
    return null;
  }

  const activeWorkspacePath = workspaces[0].uri.fsPath;
  logger.appendLine(`[Antigravity] Searching for project associated with ${activeWorkspacePath}`);

  try {
    const projects = await vscode.workspace.fs.readDirectory(antigravityDir);
    for (const [name, type] of projects) {
      if (type === vscode.FileType.Directory) {
        const projectPath = vscode.Uri.joinPath(antigravityDir, name);
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
  getApiUrl: () => string,
  force: boolean = false
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
  const rootPath = workspaceFolders?.[0].uri.fsPath;
  if (rootPath) {
    try {
      repo = childProcess.execSync("git remote get-url origin", { cwd: rootPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    } catch (e) {
      // origin might not exist, that's fine
    }
    try {
      branch = childProcess.execSync("git rev-parse --abbrev-ref HEAD", { cwd: rootPath, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    } catch (e) {
      // not a git repo or no branch
    }
  }

  const userHandle = process.env.USER || "antigravity";
  const stateKeyPrefix = `antigravity.lastUploadMtime.${projectId}`;
  let syncFailures = 0;

  // 1. Artifacts
  const artifacts = ["implementation_plan.md", "task.md", "walkthrough.md"];
  for (const fileName of artifacts) {
    const filePath = vscode.Uri.file(path.join(projectPath, fileName));
    try {
      const stat = await vscode.workspace.fs.stat(filePath);
      const lastUploadedMtime = context.globalState.get<number>(`${stateKeyPrefix}.${fileName}`, 0);
      
      if (force || stat.mtime > lastUploadedMtime) {
        logger.appendLine(`[Antigravity] Artifact ${fileName} ${force ? "force upload" : "has changed"}. Uploading...`);
        const content = await vscode.workspace.fs.readFile(filePath);
        const text = Buffer.from(content).toString("utf8");

        const payload = {
          r2Key: `antigravity/projects/${projectId}/${fileName}`,
          content: text,
          metadata: {
            title: fileName.replace(".md", "").replace("_", " "),
            author: userHandle,
            source: "antigravity",
            type: "artifact",
            repo, folder: folderName, branch
          }
        };

        const response = await postAntigravityIngest(payload, apiUrl, apiKey);
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

  const activeWorkspacePath = workspaceFolders?.[0].uri.fsPath || "";
  
  // 2. Conversation (Try Language Server first)
  let trajectoryDecrypted = false;
  try {
    const lsInfo = await discoverLanguageServer(activeWorkspacePath, logger);
    if (lsInfo) {
      logger.appendLine(`[Antigravity] Identified active Language Server for ${activeWorkspacePath} on port ${lsInfo.port}.`);
      const trajectoriesMap = await getAllCascadeTrajectories(lsInfo.port, lsInfo.csrfToken, logger);
      
      if (trajectoriesMap) {
        // The response usually contains a 'trajectorySummaries' field which is the actual map
        const actualSummaries = trajectoriesMap.trajectorySummaries || trajectoriesMap;
        const trajectoryIds = Object.keys(actualSummaries);
        logger.appendLine(`[Antigravity] Found ${trajectoryIds.length} total trajectories via LS.`);
        
        const rootPath = workspaceFolders?.[0].uri.fsPath;
        const workspaceUri = rootPath ? vscode.Uri.file(rootPath).toString() : null;

        for (const id of trajectoryIds) {
          const summary = actualSummaries[id];
          logger.appendLine(`[Antigravity] Checking trajectory ${id}: "${summary.summary || 'no summary'}"`);
          
          // Filter by workspace
          const isRelevant = summary.workspaces?.some((w: any) => {
            const wUri = w.workspaceFolderAbsoluteUri;
            const match = workspaceUri && (wUri === workspaceUri || wUri === workspaceUri + "/");
            logger.appendLine(`[Antigravity]   Comparing workspace URI: ${wUri} vs ${workspaceUri} -> Match: ${match}`);
            return match;
          });

          if (isRelevant || id === projectId) {
            logger.appendLine(`[Antigravity] Fetching trajectory ${id}...`);
            const trajectory = await getCascadeTrajectory(lsInfo.port, lsInfo.csrfToken, id, logger);
            if (trajectory) {
              const payload = {
                r2Key: `antigravity/projects/${projectId}/conversations/${id}/trajectory.json`,
                content: JSON.stringify(trajectory, null, 2),
                metadata: {
                  title: summary.summary || `Conversation ${id}`,
                  author: userHandle,
                  source: "antigravity",
                  type: "trajectory_decrypted",
                  repo, folder: folderName, branch,
                  createdAt: summary.createdTime,
                  updatedAt: summary.lastModifiedTime
                }
              };

              const response = await postAntigravityIngest(payload, apiUrl, apiKey);
              if (response.success) {
                logger.appendLine(`[Antigravity] Trajectory ${id} uploaded successfully.`);
                trajectoryDecrypted = true;
              }
            }
          }
        }
        
        if (trajectoryDecrypted) {
            await context.globalState.update(`${stateKeyPrefix}.trajectory.ts`, Date.now());
        }
      }
    }
  } catch (e) {
    logger.appendLine(`[Antigravity] Failed to extract trajectories via Language Server: ${e}`);
  }

  // 3. Status Reporting
  if (!trajectoryDecrypted) {
    logger.appendLine(`[Antigravity] Warning: No readable conversation trajectories found for project ${projectId}.`);
    syncFailures++;
  }

  if (syncFailures > 0) {
    vscode.window.showErrorMessage(`Antigravity data sync for project ${projectId} completed with ${syncFailures} failure(s). Check output for details.`);
  } else {
    vscode.window.showInformationMessage(`Antigravity data sync for project ${projectId} completed successfully.`);
  }
}

async function postAntigravityIngest(payload: any, apiUrl: string, apiKey: string): Promise<{ success: boolean; error?: string }> {
  const endpoint = `${apiUrl.replace(/\/$/, "")}/api/ingestors/antigravity/conversation`;
  
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
      return { success: false, error: `API Error ${response.statusCode}: ${response.body || "(empty response)"}` };
    }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Discover the Antigravity Language Server port and CSRF token for a specific workspace
 */
async function discoverLanguageServer(workspacePath: string, logger: vscode.OutputChannel): Promise<{ port: number, csrfToken: string } | null> {
  // Antigravity encodes workspace IDs as file_path_with_underscores
  // Example: /Users/peterp/gh/redwoodjs/oa-1 -> file_Users_peterp_gh_redwoodjs_oa_1
  // It seems to replace all non-alphanumeric characters (including hyphens) with underscores.
  const normalizedPath = workspacePath.replace(/^[\/\\]/, "").replace(/[^a-zA-Z0-9]/g, "_");
  const expectedWorkspaceId = `file_${normalizedPath}`;
  logger.appendLine(`[Antigravity] Searching for Language Server matching workspace_id: ${expectedWorkspaceId}`);

  return new Promise((resolve) => {
    // We execute ps aux and search for the language server process
    childProcess.exec('ps aux | grep language_server_macos_arm | grep -v grep', (err, stdout) => {
      if (err) {
        logger.appendLine(`[Antigravity] Error running ps: ${err.message}`);
        return resolve(null);
      }

      const lines = stdout.split('\n').filter(l => l.includes('language_server_macos_arm'));
      logger.appendLine(`[Antigravity] Found ${lines.length} candidate Language Server processes.`);

      for (const line of lines) {
        if (line.includes('--extension_server_port') && line.includes('--csrf_token')) {
          const workspaceIdMatch = line.match(/--workspace_id\s+([^\s]+)/);
          const workspaceId = workspaceIdMatch ? workspaceIdMatch[1] : "unknown";
          
          if (workspaceId !== expectedWorkspaceId) {
            logger.appendLine(`[Antigravity]   Skipping process with workspace_id: ${workspaceId} (doesn't match ${expectedWorkspaceId})`);
            continue;
          }

          logger.appendLine(`[Antigravity]   Matched Language Server process with workspace_id: ${workspaceId}`);
          const portMatch = line.match(/--extension_server_port\s+(\d+)/);
          const csrfMatch = line.match(/--csrf_token\s+([a-fA-F0-9-]+)/);

          if (portMatch && csrfMatch) {
            const extensionPort = parseInt(portMatch[1], 10);
            const csrfToken = csrfMatch[1];
            
            // Now find the actual LISTEN port for the language server
            // Match the PID from the ps output (first column usually, but ps aux format varies)
            const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
            if (pidMatch) {
              const pid = pidMatch[1];
              childProcess.exec(`lsof -nP -p ${pid} | grep LISTEN`, (err, lsofStdout) => {
                if (!err && lsofStdout) {
                  // Usually the HTTP server is one of these ports. 
                  // In our research, extension_port + 1 (e.g. 64617) was the HTTPS server.
                  const ports = [...lsofStdout.matchAll(/:(\d+)\s+\(LISTEN\)/g)].map(m => parseInt(m[1], 10));
                  // We prioritize ports near the extension port
                  const bestPort = ports.find(p => p === extensionPort + 1) || ports[0];
                  if (bestPort) {
                    return resolve({ port: bestPort, csrfToken });
                  }
                }
                // Fallback to guess
                resolve({ port: extensionPort + 1, csrfToken });
              });
              return;
            }
            return resolve({ port: extensionPort + 1, csrfToken });
          }
        }
      }
      resolve(null);
    });
  });
}

/**
 * Fetch all available Cascade trajectories summary from the Language Server
 */
async function getAllCascadeTrajectories(port: number, csrfToken: string, logger: vscode.OutputChannel): Promise<any | null> {
  const options = {
    hostname: '127.0.0.1',
    port: port,
    path: '/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Codeium-Csrf-Token': csrfToken
    },
    rejectUnauthorized: false
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            logger.appendLine(`[Antigravity] Error parsing trajectories map JSON: ${e}`);
            resolve(null);
          }
        } else {
          logger.appendLine(`[Antigravity] GetAllCascadeTrajectories failed with status ${res.statusCode}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      logger.appendLine(`[Antigravity] Request to Language Server failed (GetAll): ${e.message}`);
      resolve(null);
    });

    req.write(JSON.stringify({}));
    req.end();
  });
}

/**
 * Fetch the Cascade trajectory (decrypted conversation history) from the Language Server
 */
async function getCascadeTrajectory(port: number, csrfToken: string, projectId: string, logger: vscode.OutputChannel): Promise<any | null> {
  const options = {
    hostname: '127.0.0.1',
    port: port,
    path: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Codeium-Csrf-Token': csrfToken
    },
    rejectUnauthorized: false // Local server uses self-signed cert
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            logger.appendLine(`[Antigravity] Error parsing trajectory JSON: ${e}`);
            resolve(null);
          }
        } else {
          logger.appendLine(`[Antigravity] GetCascadeTrajectory failed with status ${res.statusCode}: ${body}`);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      logger.appendLine(`[Antigravity] Request to Language Server failed: ${e.message}`);
      resolve(null);
    });

    req.write(JSON.stringify({ cascadeId: projectId }));
    req.end();
  });
}
