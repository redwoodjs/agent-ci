import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";
import * as https from "https";
import * as http from "http";

const logger = vscode.window.createOutputChannel("Machinen");

// Track open webviews to avoid duplicates
const openWebviews = new Map<string, vscode.WebviewPanel>();
// Store codeOrigin data for each webview (for "Add to Chat" button)
const webviewCodeOriginData = new Map<string, CodeOriginInfo | null>();

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
  shortHash: string;
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
  TLDR?: string | null;
  narrative?: string;
  error?: string;
  citations?: Citation[];
  commitHashes?: string[];
  prNumbers?: number[];
  owner?: string;
  repo?: string;
}

/**
 * Interface for citation
 */
interface Citation {
  title: string;
  url: string;
  momentId: string;
  documentId?: string;
}

/**
 * Interface for PR origin information
 */
interface PrOriginInfo {
  TLDR?: string | null;
  narrative?: string;
  error?: string;
  citations?: Citation[];
  commitHashes?: string[];
  prNumbers?: number[];
}

export function activate(context: vscode.ExtensionContext) {
  logger.appendLine("Machinen is now active!");

  /**
   * Format PR origin analysis as markdown for Cursor chat
   */
  function formatPrOriginForChat(codeOrigin: CodeOriginInfo): string {
    if (!codeOrigin.narrative) {
      return "";
    }

    let markdown = "## PR Origin Analysis\n\n";
    if (codeOrigin.TLDR) {
      markdown += `**TL;DR:** ${codeOrigin.TLDR}\n\n`;
    }
    markdown += codeOrigin.narrative;

    if (codeOrigin.citations && codeOrigin.citations.length > 0) {
      markdown += "\n\n### References\n\n";
      for (const citation of codeOrigin.citations) {
        markdown += `- [${citation.title}](${citation.url})\n`;
      }
    }

    return markdown;
  }

  // Internal helper to render pop-over content into an existing panel
  function renderPopOverContent(
    panel: vscode.WebviewPanel,
    document: vscode.TextDocument,
    position: vscode.Position,
    gitInfo: GitBlameInfo | null = null,
    codeOrigin: CodeOriginInfo | null = null
  ) {
    const documentKey = `${document.uri.toString()}:${position.line}`;

    // Store codeOrigin data for "Add to Chat" button
    webviewCodeOriginData.set(documentKey, codeOrigin);
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
                    entry.shortHash
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
        // Build commits section
        const commitHashes = codeOrigin.commitHashes || [];
        let commitsHtml = "";
        if (commitHashes.length > 0 && codeOrigin.owner && codeOrigin.repo) {
          const owner = codeOrigin.owner;
          const repo = codeOrigin.repo;
          const commitsList = commitHashes
            .map(
              (hash) => `
              <li style="margin-bottom: 4px;">
                <a href="https://github.com/${escapeHtml(owner)}/${escapeHtml(
                repo
              )}/commit/${escapeHtml(
                hash
              )}" style="color: var(--vscode-textLink-foreground); text-decoration: underline; font-family: monospace;" target="_blank">${escapeHtml(
                hash.substring(0, 7)
              )}</a>
              </li>
            `
            )
            .join("");
          commitsHtml = `
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
              <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-textLink-foreground);">Commits Analyzed</h4>
              <ul style="margin: 0; padding-left: 20px; list-style-type: disc;">
                ${commitsList}
              </ul>
            </div>
          `;
        }

        // Build PRs section
        const prNumbers = codeOrigin.prNumbers || [];
        let prsHtml = "";
        if (prNumbers.length > 0 && codeOrigin.owner && codeOrigin.repo) {
          const owner = codeOrigin.owner;
          const repo = codeOrigin.repo;
          const prsList = prNumbers
            .map(
              (prNum) => `
              <li style="margin-bottom: 4px;">
                <a href="https://github.com/${escapeHtml(owner)}/${escapeHtml(
                repo
              )}/pull/${prNum}" style="color: var(--vscode-textLink-foreground); text-decoration: underline;" target="_blank">PR #${prNum}</a>
              </li>
            `
            )
            .join("");
          prsHtml = `
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
              <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-textLink-foreground);">Related Pull Requests</h4>
              <ul style="margin: 0; padding-left: 20px; list-style-type: disc;">
                ${prsList}
              </ul>
            </div>
          `;
        }

        // Process TL;DR if available
        let tldrHtml = "";
        if (codeOrigin.TLDR) {
          const processedTldr = escapeHtml(codeOrigin.TLDR);
          tldrHtml = `
            <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 4px;">
              <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-textLink-foreground); font-weight: 600;">TL;DR</h4>
              <div style="white-space: pre-wrap; color: var(--vscode-foreground); line-height: 1.6; font-style: italic;">${processedTldr}</div>
            </div>
          `;
        }

        // Process narrative to add clickable links for citations
        let processedNarrative = escapeHtml(codeOrigin.narrative);
        const citations = codeOrigin.citations || [];

        // Create a map for citation lookup - try exact match first, then partial match
        const citationMap = new Map<string, string>();
        for (const citation of citations) {
          citationMap.set(citation.title, citation.url);
          // Also try matching without brackets for flexibility
          const titleWithoutBrackets = citation.title.replace(/^\[|\]$/g, "");
          if (titleWithoutBrackets !== citation.title) {
            citationMap.set(titleWithoutBrackets, citation.url);
          }
        }

        // Replace citation references in the narrative with clickable links
        // Pattern: [GitHub Issue #123] or [GitHub Pull Request #456]
        // Also match variations like "GitHub Issue #123" without brackets
        processedNarrative = processedNarrative.replace(
          /\[([^\]]+)\]/g,
          (match, title) => {
            // Try exact match first
            let url = citationMap.get(title);
            if (!url) {
              // Try without brackets
              url = citationMap.get(title.replace(/^\[|\]$/g, ""));
            }
            if (url) {
              return `<a href="${escapeHtml(
                url
              )}" style="color: var(--vscode-textLink-foreground); text-decoration: underline;" target="_blank">${match}</a>`;
            }
            return match;
          }
        );

        // Build citations section
        let citationsHtml = "";
        if (citations.length > 0) {
          // Get API URL from configuration for audit file links
          const config = vscode.workspace.getConfiguration("machinen");
          const apiUrl = config.get<string>("apiUrl", "");
          const normalizedApiUrl = apiUrl ? apiUrl.replace(/\/$/, "") : "";

          const citationsList = citations
            .map((citation) => {
              const auditFileLink =
                citation.documentId && normalizedApiUrl
                  ? ` <a href="${escapeHtml(
                      `${normalizedApiUrl}/audit/ingestion/file/${encodeURIComponent(
                        citation.documentId
                      )}`
                    )}" style="color: var(--vscode-textLink-foreground); text-decoration: underline; font-size: 0.9em;" target="_blank">(View in Audit)</a>`
                  : "";
              return `
              <li style="margin-bottom: 8px;">
                <a href="${escapeHtml(
                  citation.url
                )}" style="color: var(--vscode-textLink-foreground); text-decoration: underline;" target="_blank">${escapeHtml(
                citation.title
              )}</a>${auditFileLink}
              </li>
            `;
            })
            .join("");
          citationsHtml = `
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border);">
              <h4 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">References</h4>
              <ul style="margin: 0; padding-left: 20px; list-style-type: disc;">
                ${citationsList}
              </ul>
            </div>
          `;
        }

        // Add button to copy to Cursor chat
        const addToChatButton =
          citations.length > 0 || codeOrigin.narrative
            ? `
            <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border);">
              <button id="add-to-chat-btn" style="
                background-color: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 8px 16px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.9em;
                font-family: var(--vscode-font-family);
              ">Add to Cursor Chat</button>
            </div>
          `
            : "";

        codeOriginHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-radius: 4px;">
            <h3 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">Code Origin & Decisions</h3>
            ${tldrHtml}
            <div style="white-space: pre-wrap; color: var(--vscode-foreground); line-height: 1.6;">${processedNarrative}</div>
            ${commitsHtml}
            ${prsHtml}
            ${citationsHtml}
            ${addToChatButton}
          </div>
        `;
      }
    }

    // Format the information as HTML (no extra debug \"Information\" block)
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
          a {
            cursor: pointer;
          }
        </style>
        <script>
          const vscode = acquireVsCodeApi();
          // Handle all link clicks to open in external browser
          document.addEventListener('click', (event) => {
            const target = event.target.closest('a');
            if (target && target.href) {
              event.preventDefault();
              vscode.postMessage({
                command: 'openExternal',
                url: target.href
              });
            }
            // Handle "Add to Cursor Chat" button
            if (event.target.id === 'add-to-chat-btn') {
              vscode.postMessage({
                command: 'addToChat'
              });
            }
          });
        </script>
      </head>
      <body>
        ${codeOriginHtml}
        ${gitInfoHtml}
      </body>
      </html>
    `;

    panel.webview.html = htmlContent;

    logger.appendLine(
      `Pop-over content rendered for document ${document.fileName} at line ${position.line}`
    );
  }

  /**
   * Show TLDR webview by embedding the audit/tldr page in an iframe
   */
  async function showTldrWebview(
    document: vscode.TextDocument,
    position: vscode.Position
  ) {
    const documentKey = `${document.uri.toString()}:${position.line}`;

    // Close existing webview for this location if open
    if (openWebviews.has(documentKey)) {
      const existingPanel = openWebviews.get(documentKey);
      if (existingPanel) {
        existingPanel.dispose();
      }
    }

    // Get filename and line number for the panel title
    const fileName = path.basename(document.fileName);
    const lineNumber = position.line + 1; // Line numbers are 1-indexed for display
    const panelTitle = `${fileName}:${lineNumber}`;

    // Get configuration
    const config = vscode.workspace.getConfiguration("machinen");
    const apiUrl = config.get<string>("apiUrl", "");
    const apiKey = config.get<string>("apiKey", "");
    const namespace = config.get<string>("namespace", "");

    if (!apiUrl || !apiKey) {
      vscode.window.showErrorMessage(
        "Machinen API URL or API key not configured. Please configure in VS Code settings."
      );
      return;
    }

    // Get git context
    const filePath = document.uri.fsPath;
    const fileDir = path.dirname(filePath);
    const fileNameForGit = path.basename(filePath);

    try {
      // Get owner/repo from git remote
      const ownerRepo = await getGitRemoteOwnerRepo(fileDir);
      if (!ownerRepo) {
        vscode.window.showErrorMessage(
          "Could not determine repository owner and name from git remote."
        );
        return;
      }

      // Get full commit hash for this line
      const commitHash = await getFullCommitHash(
        fileDir,
        fileNameForGit,
        position.line
      );
      if (!commitHash) {
        vscode.window.showErrorMessage(
          "Line is uncommitted or commit hash could not be determined."
        );
        return;
      }

      // Get relative file path from git root
      let relativePath: string;
      try {
        const gitRoot = child_process
          .execSync(`git rev-parse --show-toplevel`, {
            cwd: fileDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          })
          .trim();
        const fullPath = path.join(fileDir, fileNameForGit);
        relativePath = path.relative(gitRoot, fullPath).replace(/\\/g, "/");
      } catch (e) {
        // Fall back to just filename if we can't get git root
        relativePath = fileNameForGit;
      }

      // Construct TLDR URL
      const normalizedApiUrl = apiUrl.replace(/\/$/, "");
      const repoParam = `${ownerRepo.owner}/${ownerRepo.repo}`;
      const fileParam = `${relativePath}:${lineNumber}`;

      // Ensure URL is valid
      let url: URL;
      try {
        url = new URL(`${normalizedApiUrl}/audit/tldr`);
      } catch (e) {
        vscode.window.showErrorMessage(`Invalid API URL: ${apiUrl}`);
        return;
      }

      url.searchParams.set("repo", repoParam);
      url.searchParams.set("commit", commitHash);
      url.searchParams.set("file", fileParam);
      if (namespace) {
        url.searchParams.set("namespace", namespace);
      }
      url.searchParams.set("api_key", apiKey);

      const tldrUrl = url.toString();
      const apiOrigin = url.origin;

      // Create webview panel
      const panel = vscode.window.createWebviewPanel(
        "machinen-tldr",
        panelTitle,
        {
          viewColumn: vscode.ViewColumn.Beside,
          preserveFocus: true,
        },
        {
          enableScripts: true,
          retainContextWhenHidden: false,
        }
      );

      // Set icon for the panel
      const iconPath = vscode.Uri.joinPath(
        context.extensionUri,
        "resources",
        "comment-discussion-sparkle.svg"
      );
      panel.iconPath = iconPath;

      // Track this webview
      openWebviews.set(documentKey, panel);

      // Render iframe with TLDR page
      panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${apiOrigin} http: https:; style-src 'unsafe-inline' var:; script-src 'unsafe-inline';">
        <style>
          body {
            margin: 0;
            padding: 0;
            overflow: hidden;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-foreground);
            font-family: var(--vscode-font-family);
          }
          iframe {
            width: 100%;
            height: 100vh;
            border: none;
            background-color: var(--vscode-editor-background);
          }
          .status-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            text-align: center;
            padding: 20px;
          }
          .spinner {
            width: 40px;
            height: 40px;
            border: 4px solid var(--vscode-panel-border);
            border-top: 4px solid var(--vscode-textLink-foreground);
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-bottom: 20px;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
          code {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 2px 4px;
            border-radius: 3px;
            font-family: var(--vscode-editor-font-family);
          }
        </style>
      </head>
      <body>
        <div id="status" class="status-container">
          <div class="spinner"></div>
          <p>Loading Machinen TLDR...</p>
        </div>
        
        <iframe 
          id="tldr-iframe"
          src="${escapeHtml(tldrUrl)}"
          style="display: none;"
          onload="handleLoad()"
          onerror="handleError()"
        ></iframe>

        <script>
          const iframe = document.getElementById('tldr-iframe');
          const status = document.getElementById('status');
          
          function handleLoad() {
            status.style.display = 'none';
            iframe.style.display = 'block';
          }

          function handleError() {
            status.innerHTML = \`
              <h3 style="color: var(--vscode-errorForeground);">Error Loading TLDR</h3>
              <p>The iframe failed to load. This can happen if the server is unreachable or if framing is blocked.</p>
              <div style="margin-top: 20px;">
                <a href="${escapeHtml(
                  tldrUrl
                )}" style="background-color: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 8px 16px; border-radius: 2px; text-decoration: none; display: inline-block;">View in Browser</a>
              </div>
            \`;
          }

          // If iframe doesn't load within 15 seconds, show error
          setTimeout(() => {
            if (iframe.style.display === 'none') {
              handleError();
            }
          }, 15000);
        </script>
      </body>
      </html>
    `;

      // Clean up when panel is closed
      panel.onDidDispose(() => {
        openWebviews.delete(documentKey);
      });

      logger.appendLine(
        `TLDR webview opened for document ${document.fileName} at line ${position.line}`
      );
    } catch (error) {
      logger.appendLine(`Error showing TLDR webview: ${error}`);
      vscode.window.showErrorMessage(
        `Error showing TLDR: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

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

    // Get filename and line number for the panel title
    const fileName = path.basename(document.fileName);
    const lineNumber = position.line + 1; // Line numbers are 1-indexed for display
    const panelTitle = `${fileName}:${lineNumber}`;

    // Create webview panel
    const panel = vscode.window.createWebviewPanel(
      "machinen",
      panelTitle,
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      }
    );

    // Set icon for the panel using comment-discussion-sparkle icon
    const iconPath = vscode.Uri.joinPath(
      context.extensionUri,
      "resources",
      "comment-discussion-sparkle.svg"
    );
    panel.iconPath = iconPath;

    // Track this webview
    openWebviews.set(documentKey, panel);

    // Store codeOrigin data for the "Add to Chat" button
    webviewCodeOriginData.set(documentKey, codeOrigin);

    // Handle messages from webview (for opening external links and adding to chat)
    panel.webview.onDidReceiveMessage(
      async (message) => {
        if (message.command === "openExternal" && message.url) {
          vscode.env.openExternal(vscode.Uri.parse(message.url));
        } else if (message.command === "addToChat") {
          const storedCodeOrigin = webviewCodeOriginData.get(documentKey);
          if (storedCodeOrigin && storedCodeOrigin.narrative) {
            const markdown = formatPrOriginForChat(storedCodeOrigin);
            await vscode.env.clipboard.writeText(markdown);
            vscode.window.showInformationMessage(
              "PR origin analysis copied to clipboard! Paste it into Cursor chat."
            );
          }
        }
      },
      null,
      context.subscriptions
    );

    // Clean up when panel is closed
    panel.onDidDispose(() => {
      openWebviews.delete(documentKey);
      webviewCodeOriginData.delete(documentKey);
    });

    // Initial render (may be a loading state)
    renderPopOverContent(panel, document, position, gitInfo, codeOrigin);

    // Track this webview
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

        // Get the updated line to show in webview
        const updatedLine = event.document.lineAt(position.line);
        logger.appendLine(`Updated line: "${updatedLine.text}"`);

        // Show TLDR webview with the audit/tldr page
        showTldrWebview(event.document, position);
      }
    });
  });

  context.subscriptions.push(changeListener);

  // Register command to get PR origin for current commit
  const prOriginCommand = vscode.commands.registerCommand(
    "machinen.getPrOrigin",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage(
          "No active editor. Please open a file first."
        );
        return;
      }

      const position = editor.selection.active;

      try {
        // Show TLDR webview for the current line
        await showTldrWebview(editor.document, position);
      } catch (error) {
        logger.appendLine(`Error in PR origin command: ${error}`);
        vscode.window.showErrorMessage(
          `Error showing TLDR: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  );

  context.subscriptions.push(prOriginCommand);

  logger.appendLine("Document change listener registered successfully");
  logger.appendLine("PR origin command registered successfully");
}

/**
 * Show PR origin result in a webview
 */
async function showPrOriginResult(
  commitHashes: string[],
  ownerRepo: { owner: string; repo: string }
): Promise<void> {
  // Construct repo identifier (can be owner/repo or remote URL)
  const repoInput = `${ownerRepo.owner}/${ownerRepo.repo}`;

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Fetching PR origin...",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ increment: 0 });

      const prOrigin = await getPrOrigin(commitHashes, repoInput);
      progress.report({ increment: 100 });

      if (!prOrigin) {
        vscode.window.showErrorMessage(
          "Could not fetch PR origin. Check your API configuration."
        );
        return;
      }

      const firstHash = commitHashes[0] || "unknown";
      // Create webview panel
      const panel = vscode.window.createWebviewPanel(
        "machinen-pr-origin",
        `PR Origin: ${firstHash.substring(0, 7)}${
          commitHashes.length > 1 ? "..." : ""
        }`,
        vscode.ViewColumn.Beside,
        {
          enableScripts: false,
          retainContextWhenHidden: false,
        }
      );

      // Format PR origin information for display
      // Process TL;DR if available
      let tldrHtml = "";
      if (prOrigin.TLDR) {
        const processedTldr = escapeHtml(prOrigin.TLDR);
        tldrHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); border-radius: 4px;">
            <h4 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-textLink-foreground); font-weight: 600;">TL;DR</h4>
            <div style="white-space: pre-wrap; color: var(--vscode-foreground); line-height: 1.6; font-style: italic;">${processedTldr}</div>
          </div>
        `;
      }

      let prOriginHtml = "";
      if (prOrigin.error) {
        prOriginHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-inputValidation-errorBackground); border-radius: 4px; border-left: 3px solid var(--vscode-errorForeground);">
            <h3 style="margin-top: 0; margin-bottom: 8px; color: var(--vscode-errorForeground);">PR Origin Error</h3>
            <div style="color: var(--vscode-errorForeground);">${escapeHtml(
              prOrigin.error
            )}</div>
          </div>
        `;
      } else if (prOrigin.narrative) {
        prOriginHtml = `
          <div style="margin-bottom: 16px; padding: 12px; background-color: var(--vscode-textBlockQuote-background); border-radius: 4px;">
            <h3 style="margin-top: 0; margin-bottom: 12px; color: var(--vscode-textLink-foreground);">PR Origin & Decisions</h3>
            ${tldrHtml}
            <div style="white-space: pre-wrap; color: var(--vscode-foreground); line-height: 1.6;">${escapeHtml(
              prOrigin.narrative
            )}</div>
          </div>
        `;
      }

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
          </style>
        </head>
        <body>
          <h2>PR Origin Analysis</h2>
          <div style="margin-bottom: 16px; color: var(--vscode-descriptionForeground);">
            <strong>Commits:</strong> <code>${escapeHtml(
              commitHashes.join(", ")
            )}</code><br>
            <strong>Repository:</strong> ${escapeHtml(
              ownerRepo.owner
            )}/${escapeHtml(ownerRepo.repo)}
          </div>
          ${prOriginHtml}
        </body>
        </html>
      `;

      panel.webview.html = htmlContent;
    }
  );
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
    let gitRoot = fileDir;
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
    } catch (e) {
      // Fall back to just filename if we can't get git root
      logger.appendLine(`Error getting git root in getLineHistory: ${e}`);
    }

    const historyOutput = child_process.execSync(
      `git log -L ${lineNumber},${lineNumber}:"${relativePath}" --format="%H|%an|%at|%s"`,
      {
        cwd: gitRoot, // Run from git root, not fileDir
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
          hash: hash,
          shortHash: hash.substring(0, 7),
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
 * Extract code context (function/class) from a document at a specific line
 */
function extractCodeContext(
  document: vscode.TextDocument,
  line: number
): { codeContent: string; context: string | null } {
  // Get the code content at the line
  const lineText = document.lineAt(line).text;
  const codeContent = lineText.trim();

  // Search backwards for function/class declarations
  let context: string | null = null;

  // Patterns for common function/class declarations
  const patterns = [
    // TypeScript/JavaScript: function declarations
    /^(export\s+)?(async\s+)?function\s+(\w+)\s*\([^)]*\)/,
    // TypeScript/JavaScript: arrow functions assigned to const/let/var
    /^(export\s+)?(const|let|var)\s+(\w+)\s*[:=]\s*(async\s+)?\([^)]*\)\s*[=:>]/,
    // TypeScript/JavaScript: method in class
    /^\s*(public|private|protected)?\s*(static\s+)?(async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/,
    // TypeScript/JavaScript: class declarations
    /^(export\s+)?(abstract\s+)?class\s+(\w+)/,
    // Python: function definitions
    /^def\s+(\w+)\s*\([^)]*\)/,
    // Python: class definitions
    /^class\s+(\w+)/,
  ];

  // Search backwards from the target line
  for (let i = line; i >= 0 && i >= line - 50; i--) {
    const currentLine = document.lineAt(i).text;

    for (const pattern of patterns) {
      const match = currentLine.match(pattern);
      if (match) {
        // Extract the function/class name and signature
        const fullMatch = currentLine.trim();
        // Try to get a reasonable signature (up to 120 chars)
        if (fullMatch.length > 120) {
          context = fullMatch.substring(0, 117) + "...";
        } else {
          context = fullMatch;
        }
        break;
      }
    }

    if (context) {
      break;
    }
  }

  return { codeContent, context };
}

/**
 * Get PR origin information for a specific file and line
 * (used by the //? flow)
 */
async function getPrOriginForLine(
  filePath: string,
  line: number,
  document?: vscode.TextDocument
): Promise<CodeOriginInfo | null> {
  try {
    const fileDir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    // Get owner/repo from git remote
    const ownerRepo = await getGitRemoteOwnerRepo(fileDir);
    if (!ownerRepo) {
      return {
        error: "Could not determine repository owner and name from git remote",
      };
    }

    // Get full commit hash for this line
    const commitHash = await getFullCommitHash(fileDir, fileName, line);
    if (!commitHash) {
      return {
        error: "Line is uncommitted or commit hash could not be determined",
      };
    }

    const repoInput = `${ownerRepo.owner}/${ownerRepo.repo}`;

    // Get all commits that have touched this line
    const history = await getLineHistory(fileDir, fileName, line + 1);
    const commitHashes = history.map((h) => h.hash);

    // Fallback to the specific commit if history is empty (should not happen for a committed line)
    if (commitHashes.length === 0) {
      const commitHash = await getFullCommitHash(fileDir, fileName, line);
      if (commitHash) {
        commitHashes.push(commitHash);
      }
    }

    if (commitHashes.length === 0) {
      return {
        error: "Line is uncommitted or commit hash could not be determined",
      };
    }

    // Extract code context if document is available
    let file: string | undefined;
    let codeContent: string | undefined;
    let context: string | undefined;

    if (document) {
      // Get relative file path from git root
      try {
        const gitRoot = child_process
          .execSync(`git rev-parse --show-toplevel`, {
            cwd: fileDir,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          })
          .trim();
        const fullPath = path.join(fileDir, fileName);
        file = path.relative(gitRoot, fullPath).replace(/\\/g, "/");
      } catch (e) {
        // Fall back to just filename if we can't get git root
        file = fileName;
      }

      const codeContext = extractCodeContext(document, line);
      codeContent = codeContext.codeContent;
      context = codeContext.context || undefined;
    }

    const prOrigin = await getPrOrigin(commitHashes, repoInput, {
      file,
      line: line + 1, // API expects 1-indexed line numbers
      codeContent,
      context,
    });

    if (!prOrigin) {
      return null;
    }

    return {
      TLDR: prOrigin.TLDR,
      narrative: prOrigin.narrative,
      error: prOrigin.error,
      citations: prOrigin.citations,
      commitHashes: prOrigin.commitHashes,
      prNumbers: prOrigin.prNumbers,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
    };
  } catch (error) {
    logger.appendLine(`Error getting PR origin for line: ${error}`);
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get PR origin information from Machinen API
 */
async function getPrOrigin(
  commitHashes: string[],
  repoInput: string,
  codeContext?: {
    file?: string;
    line?: number;
    codeContent?: string;
    context?: string;
  }
): Promise<PrOriginInfo | null> {
  const config = vscode.workspace.getConfiguration("machinen");
  const apiUrl = config.get<string>("apiUrl", "");
  const apiKey = config.get<string>("apiKey", "");
  const namespace = config.get<string>("namespace", "");

  // Log configuration values (masking API key for security)
  logger.appendLine(`[VSCode Extension] Machinen configuration:`);
  logger.appendLine(`  API URL: ${apiUrl || "(not set)"}`);
  logger.appendLine(
    `  API Key: ${
      apiKey
        ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`
        : "(not set)"
    }`
  );
  logger.appendLine(
    `  Namespace: ${namespace || "(not set, will use default)"}`
  );

  if (!apiUrl || !apiKey) {
    logger.appendLine(
      "Machinen API URL or API key not configured. Skipping PR origin lookup."
    );
    return {
      error:
        "Machinen API is not configured.\n\n" +
        "To fix this:\n" +
        "1. Open VS Code Settings.\n" +
        '2. Search for "Machinen".\n' +
        '3. Set "Machinen: Api Url" to https://machinen.redwoodjs.workers.dev\n' +
        '4. Set "Machinen: Api Key" to your Machinen query API key.',
    };
  }

  try {
    // Normalize API URL (remove trailing slash if present)
    const normalizedApiUrl = apiUrl.replace(/\/$/, "");

    // Call the API using Node's https/http modules
    const url = new URL(`${normalizedApiUrl}/api/gh/pr-origin`);
    const fullUrl = url.toString();

    logger.appendLine(`[VSCode Extension] Calling PR origin API: ${fullUrl}`);
    logger.appendLine(`[VSCode Extension] Request details:`);
    logger.appendLine(
      `  Commits: ${commitHashes.length} (${commitHashes
        .slice(0, 2)
        .join(", ")}${commitHashes.length > 2 ? "..." : ""})`
    );
    logger.appendLine(`  Repo: ${repoInput}`);
    logger.appendLine(`  Namespace: ${namespace || "null (default)"}`);
    if (codeContext?.file) {
      logger.appendLine(`  File: ${codeContext.file}`);
    }
    if (codeContext?.line !== undefined) {
      logger.appendLine(`  Line: ${codeContext.line}`);
    }

    const requestBodyObj = {
      commitHashes: commitHashes,
      repo: repoInput,
      ...(codeContext?.file && { file: codeContext.file }),
      ...(codeContext?.line !== undefined && { line: codeContext.line }),
      ...(codeContext?.codeContent && { codeContent: codeContext.codeContent }),
      ...(codeContext?.context && { context: codeContext.context }),
      ...(namespace && { namespace: namespace }),
    };

    const requestBody = JSON.stringify(requestBodyObj);

    logger.appendLine(
      `[VSCode Extension] Request body (excluding codeContent): ${JSON.stringify(
        {
          ...requestBodyObj,
          codeContent: requestBodyObj.codeContent
            ? `[${requestBodyObj.codeContent.length} chars]`
            : undefined,
        }
      )}`
    );

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

    logger.appendLine(
      `[VSCode Extension] Response status: ${response.statusCode} ${response.statusMessage}`
    );
    logger.appendLine(
      `[VSCode Extension] Response body length: ${response.body.length} chars`
    );

    if (response.statusCode < 200 || response.statusCode >= 300) {
      logger.appendLine(
        `[VSCode Extension] PR origin API error: ${response.statusCode} ${response.statusMessage} - ${response.body}`
      );
      return {
        error: `API error: ${response.statusCode} ${response.statusMessage}`,
      };
    }

    // Parse JSON response
    try {
      const jsonResponse = JSON.parse(response.body) as {
        TLDR?: string | null;
        tldr?: string | null; // Backward compatibility
        narrative?: string;
        citations?: Citation[];
        commitHashes?: string[];
        prNumbers?: number[];
      };

      // Support both TLDR (new) and tldr (old) for backward compatibility
      const tldrValue = jsonResponse.TLDR ?? jsonResponse.tldr ?? null;

      logger.appendLine(`[VSCode Extension] Response parsed successfully:`);
      logger.appendLine(`  TL;DR: ${tldrValue ? "present" : "missing"}`);
      logger.appendLine(
        `  Narrative: ${
          jsonResponse.narrative
            ? `${jsonResponse.narrative.length} chars`
            : "missing"
        }`
      );
      logger.appendLine(`  Citations: ${jsonResponse.citations?.length ?? 0}`);
      logger.appendLine(
        `  PR Numbers: ${jsonResponse.prNumbers?.join(", ") ?? "none"}`
      );

      return {
        TLDR: tldrValue,
        narrative: jsonResponse.narrative || response.body,
        citations: jsonResponse.citations || [],
        commitHashes: jsonResponse.commitHashes || [],
        prNumbers: jsonResponse.prNumbers || [],
      };
    } catch (parseError) {
      // Fallback to plain text if JSON parsing fails (backward compatibility)
      logger.appendLine(
        `[VSCode Extension] Failed to parse PR origin response as JSON, using plain text: ${parseError}`
      );
      return {
        narrative: response.body,
        citations: [],
        commitHashes: [],
        prNumbers: [],
      };
    }
  } catch (error) {
    logger.appendLine(`Error fetching PR origin: ${error}`);
    return {
      error: error instanceof Error ? error.message : String(error),
    };
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
  const namespace = config.get<string>("namespace", "");

  if (!apiUrl || !apiKey) {
    logger.appendLine(
      "Machinen API URL or API key not configured. Skipping code origin lookup."
    );
    return {
      error:
        "Machinen API is not configured.\n\n" +
        "To fix this:\n" +
        "1. Open VS Code Settings.\n" +
        '2. Search for "Machinen".\n' +
        '3. Set "Machinen: Api Url" to https://machinen.redwoodjs.workers.dev\n' +
        '4. Set "Machinen: Api Key" to your Machinen query API key.',
    };
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

    // Normalize API URL (remove trailing slash if present)
    const normalizedApiUrl = apiUrl.replace(/\/$/, "");

    // Call the API using Node's https/http modules
    const url = new URL(`${normalizedApiUrl}/api/gh/code-origin`);
    const fullUrl = url.toString();
    logger.appendLine(
      `Calling code origin API: ${fullUrl} for ${ownerRepo.owner}/${ownerRepo.repo} commit ${commitHash}`
    );
    logger.appendLine(`Full URL being accessed: ${fullUrl}`);
    logger.appendLine(`Base API URL: ${normalizedApiUrl}`);
    logger.appendLine(`Path: ${url.pathname}`);

    const requestBody = JSON.stringify({
      file: relativePath,
      line: line + 1, // API expects 1-indexed line numbers
      commitHash: commitHash,
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      ...(namespace && { namespace: namespace }),
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
