import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const logger = vscode.window.createOutputChannel("Machinen");

// Track open webviews to avoid duplicates
const openWebviews = new Map<string, vscode.WebviewPanel>();

/**
 * Interface for author statistics
 */
interface AuthorStat {
  name: string;
  commits: number;
  percentage: number;
}

/**
 * Interface for line history entry
 */
interface LineHistoryEntry {
  hash: string;
  author: string;
  date: string;
  message: string;
}

/**
 * Interface for git blame information
 */
interface GitBlameInfo {
  hash: string;
  author: string;
  date: string;
  branch: string;
  message: string;
  history: LineHistoryEntry[];
  hotness: number;
  authorStats: AuthorStat[];
}

/**
 * Interface for code origin information
 */
interface CodeOriginInfo {
  narrative?: string;
  error?: string;
}

export function activate(context: vscode.ExtensionContext) {
  logger.appendLine("Machinen is now active!");

  // Function to create and show pop-over webview
  function showPopOver(
    document: vscode.TextDocument,
    position: vscode.Position,
    gitInfo: GitBlameInfo | null = null,
    codeOrigin: CodeOriginInfo | null = null
  ) {
    const documentKey = `${document.uri.toString()}:${position.line}`;

    // Close existing webview for this location if open
    if (openWebviews.has(documentKey)) {
      const existingPanel = openWebviews.get(documentKey);
      if (existingPanel) {
        existingPanel.dispose();
      }
    }

    const info = getInformationCallback(document, position);
    const infoLines = info.split("\n");

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
      "machinen",
      "Information",
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      },
      {
        enableScripts: false,
        retainContextWhenHidden: false,
      }
    );

    // Format git blame information for display
    let gitInfoHtml = "";
    if (gitInfo) {
      // Debug logging
      logger.appendLine(
        `Rendering webview: hotness=${gitInfo.hotness}, authorStats.length=${
          gitInfo.authorStats?.length || 0
        }`
      );
      // Basic blame info
      const basicInfo = `
        <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px 16px;">
          <strong>Branch:</strong>
          <span>${escapeHtml(gitInfo.branch)}</span>
          <strong>Author:</strong>
          <span>${escapeHtml(gitInfo.author)}</span>
          <strong>Hash:</strong>
          <span style="font-family: monospace;">${escapeHtml(
            gitInfo.hash
          )}</span>
          <strong>When:</strong>
          <span>${escapeHtml(gitInfo.date)}</span>
        </div>
      `;

      // Commit message section
      const messageSection = gitInfo.message
        ? `
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
          <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-textLink-foreground);">Commit Message</h4>
          <div style="white-space: pre-wrap; color: var(--vscode-descriptionForeground);">${escapeHtml(
            gitInfo.message
          )}</div>
        </div>
      `
        : "";

      // Line history section
      const historySection =
        gitInfo.history && gitInfo.history.length > 0
          ? `
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
          <h4 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">Line History</h4>
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${gitInfo.history
              .map(
                (entry) => `
              <div style="padding: 8px; background-color: var(--vscode-editor-background); border-left: 3px solid var(--vscode-textLink-foreground); padding-left: 12px;">
                <div style="display: flex; gap: 12px; margin-bottom: 4px;">
                  <span style="font-family: monospace; color: var(--vscode-textLink-foreground);">${escapeHtml(
                    entry.hash
                  )}</span>
                  <span style="color: var(--vscode-descriptionForeground);">${escapeHtml(
                    entry.author
                  )}</span>
                  <span style="color: var(--vscode-descriptionForeground);">${escapeHtml(
                    entry.date
                  )}</span>
                </div>
                <div style="color: var(--vscode-foreground); font-size: 0.9em;">${escapeHtml(
                  entry.message
                )}</div>
              </div>
            `
              )
              .join("")}
          </div>
        </div>
      `
          : "";

      // File insights section
      const hotnessLabel =
        gitInfo.hotness > 50
          ? "High frequency"
          : gitInfo.hotness > 20
          ? "Medium frequency"
          : gitInfo.hotness > 0
          ? "Low frequency"
          : "No changes";

      // Ensure authorStats is an array
      const authorStatsArray = Array.isArray(gitInfo.authorStats)
        ? gitInfo.authorStats
        : [];

      const authorImpactHtml =
        authorStatsArray.length > 0
          ? `
            <div>
              <strong style="display: block; margin-bottom: 8px;">Author Impact:</strong>
              <div style="display: flex; flex-direction: column; gap: 8px;">
                ${authorStatsArray
                  .map(
                    (stat) => `
                  <div>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                      <span>${escapeHtml(stat.name)}</span>
                      <span style="color: var(--vscode-descriptionForeground);">${
                        stat.percentage
                      }% (${stat.commits} commits)</span>
                    </div>
                    <div style="height: 6px; background-color: var(--vscode-panel-border); border-radius: 3px; overflow: hidden;">
                      <div style="height: 100%; width: ${
                        stat.percentage
                      }%; background-color: var(--vscode-textLink-foreground);"></div>
                    </div>
                  </div>
                `
                  )
                  .join("")}
              </div>
            </div>
          `
          : `
            <div style="color: var(--vscode-descriptionForeground); font-style: italic;">
              No author statistics available
            </div>
          `;

      const insightsSection = `
        <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
          <h4 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">File Insights</h4>
          <div style="margin-bottom: 16px;">
            <strong>Hotness:</strong> <span>${gitInfo.hotness} commits (${hotnessLabel})</span>
          </div>
          ${authorImpactHtml}
        </div>
      `;

      gitInfoHtml = `
        <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-radius: 4px;">
          <h3 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">Git Blame Information</h3>
          ${basicInfo}
          ${messageSection}
          ${historySection}
          ${insightsSection}
        </div>
      `;
    }

    // Format code origin information for display
    let codeOriginHtml = "";
    if (codeOrigin) {
      if (codeOrigin.error) {
        codeOriginHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-inputValidation-errorBackground); border-radius: 4px; border-left: 3px solid var(--vscode-errorForeground);">
            <h3 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-errorForeground);">Code Origin</h3>
            <div style="color: var(--vscode-errorForeground);">${escapeHtml(
              codeOrigin.error
            )}</div>
          </div>
        `;
      } else if (codeOrigin.narrative) {
        codeOriginHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-radius: 4px;">
            <h3 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">Code Origin & Decisions</h3>
            <div style="white-space: pre-wrap; color: var(--vscode-foreground); line-height: 1.6;">${escapeHtml(
              codeOrigin.narrative
            )}</div>
          </div>
        `;
      }
    }

    // Format the information as HTML
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 16px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
          }
          h2 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
          }
          h3 {
            margin-top: 0;
            color: var(--vscode-textLink-foreground);
          }
          h4 {
            margin-top: 0;
            margin-bottom: 8px;
            color: var(--vscode-textLink-foreground);
            font-size: 1em;
          }
          pre {
            background-color: var(--vscode-textBlockQuote-background);
            padding: 12px;
            border-radius: 4px;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
          }
          code {
            font-family: var(--vscode-editor-font-family);
          }
        </style>
      </head>
      <body>
        <h2>Information</h2>
        ${codeOriginHtml}
        ${gitInfoHtml}
        <pre><code>${infoLines
          .map((line) => escapeHtml(line))
          .join("\n")}</code></pre>
      </body>
      </html>
    `;

    panel.webview.html = htmlContent;

    // Track this webview
    openWebviews.set(documentKey, panel);

    // Clean up when panel is closed
    panel.onDidDispose(() => {
      openWebviews.delete(documentKey);
    });

    logger.appendLine(
      `Pop-over opened for document ${document.fileName} at line ${position.line}`
    );
  }

  // Listen for document changes to detect the exact moment //? is typed
  const changeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.uri.scheme !== "file") {
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== event.document) {
      return;
    }

    // Check each change to see if ? was just typed after // or if //? was removed
    event.contentChanges.forEach((change) => {
      const position = change.range.start;
      const lineNumber = position.line;
      const documentKey = `${event.document.uri.toString()}:${lineNumber}`;

      // Check if text was deleted (removed)
      if (change.text.length === 0 && change.rangeLength > 0) {
        // Text was deleted, check if //? is no longer on this line
        const updatedLine = event.document.lineAt(lineNumber);
        if (!updatedLine.text.includes("//?")) {
          // //? was removed, close the webview if it exists
          if (openWebviews.has(documentKey)) {
            const panel = openWebviews.get(documentKey);
            if (panel) {
              panel.dispose();
              logger.appendLine(
                `Closed webview for line ${lineNumber} after //? was removed`
              );
            }
          }
        }
        return;
      }

      // Only process insertions
      if (change.text.length === 0) {
        return;
      }

      const insertedText = change.text;

      // Check if the inserted text is "?" or contains "?"
      if (!insertedText.includes("?")) {
        return;
      }

      // Get the line before the change to check what was there
      const lineBefore = event.document.lineAt(position.line);
      const lineTextBefore = lineBefore.text.substring(0, position.character);

      // Check if we just typed "?" and the text before cursor ends with "//"
      if (insertedText === "?" && lineTextBefore.endsWith("//")) {
        logger.appendLine(
          `Detected //? typed at line ${position.line}, character ${position.character}`
        );

        // Get the updated line to show in pop-over
        const updatedLine = event.document.lineAt(position.line);
        logger.appendLine(`Updated line: "${updatedLine.text}"`);

        // Get git blame information for this line, then show pop-over with the info
        const filePath = event.document.uri.fsPath;
        Promise.all([
          getGitInfo(filePath, position.line),
          getCodeOrigin(filePath, position.line),
        ]).then(([gitInfo, codeOrigin]) => {
          if (gitInfo) {
            logger.appendLine(
              `Git info: Branch: ${gitInfo.branch} | Author: ${gitInfo.author} | Hash: ${gitInfo.hash} | When: ${gitInfo.date}`
            );
          } else {
            logger.appendLine("Could not retrieve git blame information");
          }
          if (codeOrigin) {
            logger.appendLine(
              `Code origin: ${
                codeOrigin.error ? "Error: " + codeOrigin.error : "Success"
              }`
            );
          }
          // Show pop-over with git info and code origin
          showPopOver(event.document, position, gitInfo, codeOrigin);
        });
      }
    });
  });

  context.subscriptions.push(changeListener);

  logger.appendLine("Document change listener registered successfully");
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Get line history for a specific line in a file
 */
async function getLineHistory(
  fileDir: string,
  fileName: string,
  lineNumber: number
): Promise<LineHistoryEntry[]> {
  try {
    // Get the relative path from git root
    let relativePath = fileName;
    try {
      const gitRoot = child_process
        .execSync(`git rev-parse --show-toplevel`, {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
        .trim();
      const fullPath = path.join(fileDir, fileName);
      relativePath = path.relative(gitRoot, fullPath);
    } catch (e) {
      // Fall back to just filename if we can't get git root
    }

    const historyOutput = child_process.execSync(
      `git log -L ${lineNumber},${lineNumber}:"${relativePath}" --format="%H|%an|%at|%s"`,
      {
        cwd: fileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const entries: LineHistoryEntry[] = [];
    const lines = historyOutput.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split("|");
      if (parts.length >= 4) {
        const hash = parts[0];
        const author = parts[1];
        const timestamp = parseInt(parts[2], 10);
        const message = parts.slice(3).join("|"); // In case message contains |

        entries.push({
          hash: hash.substring(0, 7),
          author,
          date: new Date(timestamp * 1000).toLocaleString(),
          message,
        });
      }
    }

    return entries;
  } catch (error) {
    logger.appendLine(`Error getting line history: ${error}`);
    return [];
  }
}

/**
 * Get file insights: hotness (commit count) and author statistics
 */
async function getFileInsights(
  fileDir: string,
  fileName: string
): Promise<{ hotness: number; authorStats: AuthorStat[] }> {
  let hotness = 0;
  let authorStats: AuthorStat[] = [];

  // Get the git root directory and relative path
  let gitRoot: string;
  let relativePath: string;
  try {
    gitRoot = child_process
      .execSync(`git rev-parse --show-toplevel`, {
        cwd: fileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();
    const fullPath = path.join(fileDir, fileName);
    relativePath = path.relative(gitRoot, fullPath);
    // Normalize path separators for git commands (use forward slashes)
    relativePath = relativePath.replace(/\\/g, "/");
    logger.appendLine(
      `File insights: gitRoot=${gitRoot}, relativePath=${relativePath}`
    );
  } catch (e) {
    logger.appendLine(`Error getting git root: ${e}`);
    return { hotness: 0, authorStats: [] };
  }

  try {
    // Get total commit count for the file
    // Use git root as working directory
    const countOutput = child_process.execSync(
      `git rev-list --count HEAD -- "${relativePath}"`,
      {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    hotness = parseInt(countOutput.trim(), 10) || 0;
    logger.appendLine(`File hotness: ${hotness} commits`);
  } catch (error) {
    logger.appendLine(`Error getting file hotness: ${error}`);
  }

  try {
    // Get author statistics
    // Use git root as working directory
    const shortlogOutput = child_process.execSync(
      `git shortlog -sn -- "${relativePath}"`,
      {
        cwd: gitRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const rawOutput = shortlogOutput.trim();
    logger.appendLine(`Author stats raw output: "${rawOutput}"`);

    if (!rawOutput) {
      logger.appendLine("No author stats output from git shortlog");
      return { hotness, authorStats: [] };
    }

    const lines = rawOutput.split("\n");
    const totalCommits = hotness || 1; // Avoid division by zero

    logger.appendLine(`Author stats: ${lines.length} lines to process`);

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Try multiple regex patterns to match different git shortlog formats
      // Format 1: "     5  Author Name" (with spaces)
      // Format 2: "5\tAuthor Name" (with tabs)
      // Format 3: "5 Author Name" (single space)
      let match = trimmedLine.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        // Try with tabs
        match = trimmedLine.match(/^(\d+)\t(.+)$/);
      }
      if (!match) {
        // Try with any whitespace
        match = trimmedLine.match(/^(\d+)[\s\t]+(.+)$/);
      }

      if (match) {
        const commits = parseInt(match[1], 10);
        const name = match[2].trim();
        const percentage = Math.round((commits / totalCommits) * 100);

        logger.appendLine(
          `Parsed author: ${name} - ${commits} commits (${percentage}%)`
        );

        authorStats.push({
          name,
          commits,
          percentage,
        });
      } else {
        logger.appendLine(`Failed to parse line: "${trimmedLine}"`);
      }
    }

    // Sort by commits descending
    authorStats.sort((a, b) => b.commits - a.commits);
    logger.appendLine(
      `Author stats: ${authorStats.length} authors successfully processed`
    );
  } catch (error) {
    logger.appendLine(`Error getting author stats: ${error}`);
    // Log the full error for debugging
    if (error instanceof Error) {
      logger.appendLine(`Error message: ${error.message}`);
      logger.appendLine(`Error stack: ${error.stack}`);
    }
  }

  return { hotness, authorStats };
}

/**
 * Get git blame information for a specific line in a file
 */
async function getGitInfo(
  filePath: string,
  line: number
): Promise<GitBlameInfo | null> {
  try {
    // Get the directory containing the file (for git commands)
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    // Run git blame with porcelain format to get detailed info
    // Line numbers are 1-indexed in git blame
    const blameLine = line + 1;
    const blameOutput = child_process.execSync(
      `git blame --porcelain -L ${blameLine},${blameLine} "${fileName}"`,
      {
        cwd: fileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    // Parse the blame output
    // Format: hash, author, author-mail, author-time, author-tz, committer, committer-mail, committer-time, committer-tz, summary, previous, filename
    const lines = blameOutput.split("\n");
    const hash = lines[0].split(" ")[0];

    let author = "Unknown";
    let date = "Unknown";

    for (const line of lines) {
      if (line.startsWith("author ")) {
        author = line.substring(7);
      } else if (line.startsWith("author-time ")) {
        const timestamp = parseInt(line.substring(12), 10);
        date = new Date(timestamp * 1000).toLocaleString();
      }
    }

    // Check if this is an uncommitted line (hash is all zeros)
    if (hash === "0000000000000000000000000000000000000000") {
      // For uncommitted lines, get the current branch and basic info
      try {
        const currentBranch = child_process.execSync(
          `git rev-parse --abbrev-ref HEAD`,
          {
            cwd: fileDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        // Still fetch file insights even for uncommitted lines
        const { hotness, authorStats } = await getFileInsights(
          fileDir,
          fileName
        );
        return {
          hash: "uncommitted",
          author: "Uncommitted",
          date: "Now",
          branch: currentBranch.trim(),
          message: "Uncommitted changes",
          history: [],
          hotness,
          authorStats,
        };
      } catch (e) {
        return {
          hash: "uncommitted",
          author: "Uncommitted",
          date: "Now",
          branch: "Unknown",
          message: "Uncommitted changes",
          history: [],
          hotness: 0,
          authorStats: [],
        };
      }
    }

    const shortHash = hash.substring(0, 7);

    // Get branch name - try to find branches containing this commit
    let branch = "Unknown";
    try {
      // First, try to get branches that contain this commit
      const branchesOutput = child_process.execSync(
        `git branch --contains ${hash}`,
        {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      const branches = branchesOutput
        .trim()
        .split("\n")
        .map((b) => b.replace(/^\*\s*/, "").trim())
        .filter((b) => b.length > 0);
      if (branches.length > 0) {
        // Prefer current branch if it's in the list
        try {
          const currentBranch = child_process
            .execSync(`git rev-parse --abbrev-ref HEAD`, {
              cwd: fileDir,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
            })
            .trim();
          if (branches.includes(currentBranch)) {
            branch = currentBranch;
          } else {
            branch = branches[0];
          }
        } catch (e) {
          branch = branches[0];
        }
      } else {
        // Fall back to name-rev
        const branchOutput = child_process.execSync(
          `git name-rev --name-only ${hash}`,
          {
            cwd: fileDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        branch = branchOutput.trim().replace(/^(remotes\/[^\/]+\/|tags\/)/, "");
      }
    } catch (error) {
      // If all methods fail, try to get current branch
      try {
        const currentBranch = child_process.execSync(
          `git rev-parse --abbrev-ref HEAD`,
          {
            cwd: fileDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          }
        );
        branch = currentBranch.trim();
      } catch (e) {
        // Keep "Unknown" if all fail
      }
    }

    // Get commit message
    let message = "No commit message";
    try {
      const messageOutput = child_process.execSync(
        `git show -s --format="%B" ${hash}`,
        {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }
      );
      message = messageOutput.trim();
    } catch (error) {
      logger.appendLine(`Error getting commit message: ${error}`);
    }

    // Get line history
    const history = await getLineHistory(fileDir, fileName, blameLine);

    // Get file insights (hotness and author stats)
    const { hotness, authorStats } = await getFileInsights(fileDir, fileName);

    return {
      hash: shortHash,
      author,
      date,
      branch,
      message,
      history,
      hotness,
      authorStats,
    };
  } catch (error) {
    logger.appendLine(`Error getting git info: ${error}`);
    return null;
  }
}

/**
 * Get git remote URL and parse owner/repo
 */
async function getGitRemoteOwnerRepo(
  fileDir: string
): Promise<{ owner: string; repo: string } | null> {
  try {
    const remoteUrl = child_process
      .execSync(`git config --get remote.origin.url`, {
        cwd: fileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .trim();

    // Parse GitHub URL (supports both https and ssh formats)
    // https://github.com/owner/repo.git
    // git@github.com:owner/repo.git
    const httpsMatch = remoteUrl.match(
      /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/
    );
    if (httpsMatch) {
      return {
        owner: httpsMatch[1],
        repo: httpsMatch[2],
      };
    }

    logger.appendLine(`Could not parse git remote URL: ${remoteUrl}`);
    return null;
  } catch (error) {
    logger.appendLine(`Error getting git remote: ${error}`);
    return null;
  }
}

/**
 * Get full commit hash for a line
 */
async function getFullCommitHash(
  fileDir: string,
  fileName: string,
  line: number
): Promise<string | null> {
  try {
    const blameLine = line + 1;
    const blameOutput = child_process.execSync(
      `git blame --porcelain -L ${blameLine},${blameLine} "${fileName}"`,
      {
        cwd: fileDir,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    const lines = blameOutput.split("\n");
    const hash = lines[0].split(" ")[0];

    // Check if this is an uncommitted line
    if (hash === "0000000000000000000000000000000000000000") {
      return null;
    }

    return hash;
  } catch (error) {
    logger.appendLine(`Error getting commit hash: ${error}`);
    return null;
  }
}

/**
 * Get code origin information from Machinen API
 */
async function getCodeOrigin(
  filePath: string,
  line: number
): Promise<CodeOriginInfo | null> {
  const config = vscode.workspace.getConfiguration("machinen");
  const apiUrl = config.get<string>("apiUrl", "");
  const apiKey = config.get<string>("apiKey", "");

  if (!apiUrl || !apiKey) {
    logger.appendLine(
      "Machinen API URL or API key not configured. Skipping code origin lookup."
    );
    return null;
  }

  try {
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    // Get git root and relative path
    let relativePath = fileName;
    try {
      const gitRoot = child_process
        .execSync(`git rev-parse --show-toplevel`, {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
        .trim();
      const fullPath = path.join(fileDir, fileName);
      relativePath = path.relative(gitRoot, fullPath);
      // Normalize path separators
      relativePath = relativePath.replace(/\\/g, "/");
    } catch (e) {
      logger.appendLine(`Error getting git root: ${e}`);
      return null;
    }

    // Get owner/repo from git remote
    const ownerRepo = await getGitRemoteOwnerRepo(fileDir);
    if (!ownerRepo) {
      return {
        error: "Could not determine repository owner and name from git remote",
      };
    }

    // Get full commit hash
    const commitHash = await getFullCommitHash(fileDir, fileName, line);
    if (!commitHash) {
      return {
        error: "Line is uncommitted or commit hash could not be determined",
      };
    }

    // Call the API using Node's https/http modules
    const url = new URL(`${apiUrl}/api/gh/code-origin`);
    logger.appendLine(
      `Calling code origin API: ${url.toString()} for ${ownerRepo.owner}/${
        ownerRepo.repo
      } commit ${commitHash}`
    );

    const requestBody = JSON.stringify({
      file: relativePath,
      line: line + 1, // API expects 1-indexed line numbers
      commitHash: commitHash,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
    });

    const response = await new Promise<{
      statusCode: number;
      statusMessage: string;
      body: string;
    }>((resolve, reject) => {
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(requestBody),
        },
      };

      const client = url.protocol === "https:" ? https : http;
      const req = client.request(options, (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 500,
            statusMessage: res.statusMessage || "Unknown",
            body,
          });
        });
      });

      req.on("error", (error) => {
        reject(error);
      });

      req.write(requestBody);
      req.end();
    });

    if (response.statusCode < 200 || response.statusCode >= 300) {
      logger.appendLine(
        `Code origin API error: ${response.statusCode} ${response.statusMessage} - ${response.body}`
      );
      return {
        error: `API error: ${response.statusCode} ${response.statusMessage}`,
      };
    }

    return {
      narrative: response.body,
    };
  } catch (error) {
    logger.appendLine(`Error fetching code origin: ${error}`);
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Callback function that returns information to be displayed in the pop-over.
 * This can be customized to fetch information from various sources.
 */
function getInformationCallback(
  document: vscode.TextDocument,
  position: vscode.Position
): string {
  const line = document.lineAt(position.line);
  const lineText = line.text;

  // Placeholder implementation - can be customized
  // Return multiline formatted information
  const info = [
    "Information:",
    `  Line content: ${lineText.trim()}`,
    `  File: ${document.fileName}`,
    "  (Customize this callback to return relevant information.)",
  ].join("\n");

  return info;
}

export function deactivate() {}
