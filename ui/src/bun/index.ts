import { BrowserWindow, Utils, Tray, defineElectrobunRPC } from "electrobun/bun";
import path from "node:path";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { workingDirectory, getWorkspaceRoot, getLogsDir, getUserDataDir } from "./config.ts";

let procs: any[] = [];
let trayInstance: Tray | null = null;
let currentTrayStatus: "Idle" | "Pending" | "Running" | "Passed" | "Failed" = "Idle";
let activeRunId: string = "";

function updateTrayStatus(status: "Idle" | "Pending" | "Running" | "Passed" | "Failed") {
  if (!trayInstance || currentTrayStatus === status) {
    return;
  }
  currentTrayStatus = status;
  const basePath = path.join(import.meta.dirname, "../assets");
  let imgPath = path.join(basePath, "tray-idle.png");
  if (status === "Pending") {
    imgPath = path.join(basePath, "tray-pending.png");
  } else if (status === "Running") {
    imgPath = path.join(basePath, "tray-running.png");
  } else if (status === "Passed") {
    imgPath = path.join(basePath, "tray-passed.png");
  } else if (status === "Failed") {
    imgPath = path.join(basePath, "tray-failed.png");
  }
  if (trayInstance) {
    try {
      trayInstance.setImage(imgPath);
    } catch (e) {
      console.error("Failed to set tray image", e);
    }
  }
}

// Status emoji per run status
function statusEmoji(status: string): string {
  switch (status) {
    case "Pending":
      return "⏳";
    case "Running":
      return "🔄";
    case "Passed":
      return "✅";
    case "Failed":
      return "❌";
    default:
      return "⚪";
  }
}

// Format relative time (e.g. "2m ago", "1h ago")
function relativeTime(dateMs: number): string {
  const diff = Math.max(0, Date.now() - dateMs);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) {
    return `${secs}s ago`;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Build and set the tray context menu with recent runs
async function buildTrayMenu() {
  if (!trayInstance) {
    return;
  }

  type RunInfo = {
    runId: string;
    workflowName: string;
    jobName: string | null;
    repoPath: string;
    status: string;
    date: number;
    endDate?: number;
  };

  let runs: RunInfo[] = [];
  try {
    const res = await fetch("http://localhost:8912/runs/recent?limit=10");
    if (res.ok) {
      runs = await res.json();
    }
  } catch {
    // Server not ready yet
  }

  // Also fetch and apply the real status
  try {
    const statusRes = await fetch("http://localhost:8912/status");
    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData && statusData.status) {
        updateTrayStatus(statusData.status);
      }
    }
  } catch {}

  const menu: any[] = [];

  // Status header
  menu.push({
    type: "normal",
    label: `OA — ${currentTrayStatus}`,
    enabled: false,
  });

  menu.push({ type: "separator" });

  // Group runs by repo
  if (runs.length > 0) {
    const repoOrder: string[] = [];
    const repoGroups = new Map<string, RunInfo[]>();
    for (const run of runs) {
      const key = run.repoPath || "Unknown";
      if (!repoGroups.has(key)) {
        repoGroups.set(key, []);
        repoOrder.push(key);
      }
      repoGroups.get(key)!.push(run);
    }

    for (let ri = 0; ri < repoOrder.length; ri++) {
      const repoPath = repoOrder[ri];
      const repoRuns = repoGroups.get(repoPath)!;
      const repoName = repoPath.split("/").pop() || repoPath;

      if (ri > 0) {
        menu.push({ type: "separator" });
      }

      // Repo header
      menu.push({
        type: "normal",
        label: repoName,
        enabled: false,
      });

      for (const run of repoRuns) {
        const emoji = statusEmoji(run.status);
        const name = run.jobName ? `${run.workflowName} (${run.jobName})` : run.workflowName;
        const time = relativeTime(run.date);
        menu.push({
          type: "normal",
          label: `${emoji}  ${name} — ${time}`,
          action: "open-run",
          data: { runId: run.runId },
        });
      }
    }
  } else {
    menu.push({
      type: "normal",
      label: "No recent runs",
      enabled: false,
    });
  }

  menu.push({ type: "separator" });

  menu.push({
    type: "normal",
    label: "Quit OA",
    action: "quit-app",
  });

  try {
    trayInstance.setMenu(menu);
  } catch (e) {
    console.error("Failed to set tray menu", e);
  }
}

async function startBackgroundProcesses() {
  const spawnArgs = ["pnpm", "--filter", "supervisor", "run", "oa", "server"];

  const supervisorProc = Bun.spawn(spawnArgs, {
    cwd: getWorkspaceRoot(),
    env: { ...process.env, OA_WORKSPACE_DIR: getWorkspaceRoot() },
    stdout: "pipe",
    stderr: "pipe",
  });

  procs.push(supervisorProc);

  const readOutput = async (stream: ReadableStream | null, label: string) => {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      console.log(`[${label}] `, decoder.decode(value));
    }
  };

  readOutput(supervisorProc.stdout, "Supervisor Server");
  readOutput(supervisorProc.stderr, "Supervisor Server Error");

  // Use SSE events to update tray icon and menu
  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (
          data.type === "connected" ||
          data.type === "runStarted" ||
          data.type === "runFinished"
        ) {
          // buildTrayMenu also fetches and applies the real status
          await buildTrayMenu();
        }
      } catch {}
    });
    evtSource.addEventListener("error", () => {
      // SSE disconnected — will auto-reconnect, but refresh on next connect
    });
  } catch {}

  // Periodic fallback: refresh tray every 30s in case SSE events were missed
  setInterval(() => buildTrayMenu(), 30_000);
}

const rpc = defineElectrobunRPC<MyRPCSchema, "bun">("bun", {
  handlers: {
    requests: {
      selectRepo: async () => {
        const paths = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });

        if (paths && paths.length > 0) {
          const selectedPath = paths[0];
          // Adding to recent repos is now done via API call in the UI layer
          return selectedPath;
        }
        return null;
      },
      getInitialState: async () => {
        const repoPath = getWorkspaceRoot();
        let branchName = "main";
        try {
          const { execSync } = await import("node:child_process");
          branchName = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath })
            .toString()
            .trim();
        } catch {
          // fallback to main
        }
        return {
          repoPath,
          branchName,
        };
      },
      getBranches: async () => {
        const repoPath = getWorkspaceRoot();
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(execFile);

          const { stdout: headOut } = await execAsync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            {
              cwd: repoPath,
            },
          );
          const currentBranch = headOut.trim();

          const { stdout } = await execAsync(
            "git",
            [
              "for-each-ref",
              "--sort=-committerdate",
              "--format=%(refname)|%(committerdate:unix)",
              "refs/heads/",
              "refs/remotes/",
            ],
            { cwd: repoPath },
          );

          const seen = new Map<
            string,
            { name: string; isCurrent: boolean; isRemote: boolean; lastCommitDate: number }
          >();

          for (const line of stdout.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            const [refname, dateStr] = line.split("|");
            const lastCommitDate = parseInt(dateStr, 10) * 1000;
            const isRemote = refname.startsWith("refs/remotes/");
            let name: string;
            if (isRemote) {
              name = refname.replace(/^refs\/remotes\/[^/]+\//, "");
            } else {
              name = refname.replace(/^refs\/heads\//, "");
            }
            if (name === "HEAD") {
              continue;
            }
            const isCurrent = name === currentBranch;
            if (!seen.has(name)) {
              seen.set(name, { name, isCurrent, isRemote, lastCommitDate });
            } else if (!isRemote) {
              seen.set(name, { name, isCurrent, isRemote: false, lastCommitDate });
            }
          }

          return Array.from(seen.values()).sort((a, b) => {
            if (a.isCurrent !== b.isCurrent) {
              return a.isCurrent ? -1 : 1;
            }
            return b.lastCommitDate - a.lastCommitDate;
          });
        } catch (e) {
          console.error("getBranches RPC failed", e);
          return [];
        }
      },
      getCommits: async ({ branch }: { branch: string }) => {
        const repoPath = getWorkspaceRoot();
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(execFile);
          const target = branch === "WORKING_TREE" ? "HEAD" : branch;
          const { stdout } = await execAsync(
            "git",
            ["log", target, "-n", "100", "--format=%H|%s|%an|%cI"],
            { cwd: repoPath },
          );
          return stdout
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => {
              const [id, label, author, dateStr] = line.split("|");
              return { id, label, author, date: new Date(dateStr).getTime() };
            });
        } catch (e) {
          console.error("getCommits RPC failed", e);
          return [];
        }
      },
      getWorkingTreeDirty: async () => {
        const repoPath = getWorkspaceRoot();
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execAsync = promisify(execFile);
          const { stdout } = await execAsync("git", ["status", "--porcelain"], { cwd: repoPath });
          return stdout.trim().length > 0;
        } catch (e) {
          console.error("getWorkingTreeDirty RPC failed", e);
          return false;
        }
      },
      openRunInFinder: async ({ runId }: { runId: string }) => {
        try {
          const { execFile } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const os = await import("node:os");
          const fs = await import("node:fs");
          const execAsync = promisify(execFile);

          const repoBasename = path.basename(getWorkspaceRoot());
          const runsDir = path.join(os.tmpdir(), "machinen", repoBasename, "runs");

          console.log(
            JSON.stringify({
              event: "openRunInFinder:start",
              runId,
              repoBasename,
              runsDir,
              runsDirExists: fs.existsSync(runsDir),
            }),
          );

          let target = runsDir;

          if (fs.existsSync(runsDir)) {
            const exact = path.join(runsDir, runId);
            const exactExists = fs.existsSync(exact);
            console.log(
              JSON.stringify({ event: "openRunInFinder:exactCheck", exact, exactExists }),
            );

            if (exactExists) {
              target = exact;
            } else {
              const entries = fs.readdirSync(runsDir, { withFileTypes: true });
              const dirs = entries.filter((e: any) => e.isDirectory()).map((e: any) => e.name);
              console.log(
                JSON.stringify({
                  event: "openRunInFinder:scan",
                  dirCount: dirs.length,
                  dirs: dirs.slice(0, 10),
                }),
              );

              for (const entry of entries) {
                if (!entry.isDirectory()) {
                  continue;
                }
                const metaPath = path.join(runsDir, entry.name, "logs", "metadata.json");
                try {
                  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
                  const match =
                    meta.workflowRunId === runId || meta.taskId === runId || entry.name === runId;
                  if (match) {
                    console.log(
                      JSON.stringify({
                        event: "openRunInFinder:match",
                        dir: entry.name,
                        workflowRunId: meta.workflowRunId,
                        taskId: meta.taskId,
                      }),
                    );
                    target = path.join(runsDir, entry.name);
                    break;
                  }
                } catch {
                  // Skip entries with no/invalid metadata
                }
              }
            }
          } else {
            console.log(JSON.stringify({ event: "openRunInFinder:creatingRunsDir" }));
            fs.mkdirSync(runsDir, { recursive: true });
          }

          console.log(JSON.stringify({ event: "openRunInFinder:opening", target }));
          await execAsync("open", ["-R", target]);
        } catch (e) {
          console.error("openRunInFinder RPC failed", e);
        }
      },
      setActiveRunId: async ({ runId }: { runId: string }) => {
        activeRunId = runId;
      },
      getActiveRunId: async () => {
        return activeRunId;
      },
      getRunDetail: async ({ runId }: { runId: string }) => {
        try {
          const os = await import("node:os");
          const fsP = await import("node:fs/promises");
          const repoBasename = path.basename(getWorkspaceRoot());
          const logsDir = path.join(os.tmpdir(), "machinen", repoBasename, "runs", runId, "logs");
          const metaPath = path.join(logsDir, "metadata.json");
          const meta = JSON.parse(await fsP.readFile(metaPath, "utf-8"));
          // Derive status: check if process is still running by looking for active marker
          const status = meta.status || "Unknown";
          return {
            runId,
            runnerName: runId,
            workflowName: meta.workflowName || runId,
            jobName: meta.jobName || null,
            status,
            date: meta.date || 0,
            endDate: meta.endDate,
            repoPath: meta.repoPath,
            commitId: meta.commitId,
            taskId: meta.taskId ?? null,
            workflowRunId: meta.workflowRunId ?? runId,
            attempt: meta.attempt ?? 1,
            warmCache: meta.warmCache,
            logsPath: logsDir,
          };
        } catch (e) {
          console.error("getRunDetail RPC failed", e);
          return null;
        }
      },
      getRunLogs: async ({ runId }: { runId: string }) => {
        try {
          const os = await import("node:os");
          const fsP = await import("node:fs/promises");
          const repoBasename = path.basename(getWorkspaceRoot());
          const logsDir = path.join(os.tmpdir(), "machinen", repoBasename, "runs", runId, "logs");

          // Prefer step-output.log, then process-stdout.log, then output.log, then stderr
          for (const filename of ["step-output.log", "process-stdout.log", "output.log"]) {
            try {
              const content = await fsP.readFile(path.join(logsDir, filename), "utf-8");
              if (content.trim()) {
                return content;
              }
            } catch {}
          }
          // Fall back to stderr
          try {
            const stderr = await fsP.readFile(path.join(logsDir, "process-stderr.log"), "utf-8");
            if (stderr.trim()) {
              return stderr;
            }
          } catch {}
          return "";
        } catch (e) {
          console.error("getRunLogs RPC failed", e);
          return "";
        }
      },
      getRunTimeline: async ({ runId }: { runId: string }) => {
        try {
          const os = await import("node:os");
          const fsP = await import("node:fs/promises");
          const repoBasename = path.basename(getWorkspaceRoot());
          const timelinePath = path.join(
            os.tmpdir(),
            "machinen",
            repoBasename,
            "runs",
            runId,
            "logs",
            "timeline.json",
          );
          const raw = await fsP.readFile(timelinePath, "utf-8");
          const parsed = JSON.parse(raw);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      },
      getRunErrors: async ({ runId }: { runId: string }) => {
        try {
          const os = await import("node:os");
          const fsP = await import("node:fs/promises");
          const repoBasename = path.basename(getWorkspaceRoot());
          const logsDir = path.join(os.tmpdir(), "machinen", repoBasename, "runs", runId, "logs");

          // Read the same log file chain as getRunLogs
          let logContent = "";
          for (const filename of ["step-output.log", "process-stdout.log", "output.log"]) {
            try {
              const content = await fsP.readFile(path.join(logsDir, filename), "utf-8");
              if (content.trim()) {
                logContent = content;
                break;
              }
            } catch {}
          }
          if (!logContent) {
            try {
              logContent = await fsP.readFile(path.join(logsDir, "process-stderr.log"), "utf-8");
            } catch {}
          }
          if (!logContent) {
            return [];
          }

          const lines = logContent.split("\n");
          const annotations: {
            severity: string;
            message: string;
            line: number;
            context: string[];
          }[] = [];
          const ESC = String.fromCharCode(27);
          const ansiRegex = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

          for (let i = 0; i < lines.length; i++) {
            const stripped = lines[i].replace(ansiRegex, "").replace(/\uFEFF/g, "");
            const match = stripped.match(/##\[(error|warning|notice)\](.*)/);
            if (!match) {
              continue;
            }

            const severity = match[1];
            const message = match[2].trim();
            const contextStart = Math.max(0, i - 3);
            const contextEnd = Math.min(lines.length - 1, i + 3);
            const context: string[] = [];
            const tsRegex = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/;
            for (let j = contextStart; j <= contextEnd; j++) {
              context.push(
                lines[j]
                  .replace(ansiRegex, "")
                  .replace(/\uFEFF/g, "")
                  .replace(tsRegex, ""),
              );
            }
            annotations.push({ severity, message, line: i + 1, context });
          }
          return annotations;
        } catch {
          return [];
        }
      },
    },
  },
});

startBackgroundProcesses();

const trayIconPath = path.join(import.meta.dirname, "../assets/tray-idle.png");
const tray = new Tray({
  title: "OA",
  image: trayIconPath,
  template: false,
});

trayInstance = tray;
updateTrayStatus("Idle");

// Build initial menu (runs may be empty until server starts)
buildTrayMenu();

// Re-fetch runs and rebuild menu once server is likely ready
setTimeout(() => buildTrayMenu(), 3000);

tray.on("tray-clicked", async (e: any) => {
  const action = e.data?.action;

  if (action === "quit-app") {
    procs.forEach((p) => p.kill());
    Utils.quit();
  }

  if (action === "open-run" && e.data?.data?.runId) {
    // Navigate the main window to the runs page — the runs page reads runId from state
    try {
      mainWindow.webview.loadURL("views://runs/index.html");
    } catch {
      // Fallback: use evaluateJavaScript
      try {
        mainWindow.webview.executeJavascript(`window.location.href = "views://runs/index.html";`);
      } catch (err) {
        console.error("Failed to navigate to run logs", err);
      }
    }
  }
});

const mainWindow = new BrowserWindow({
  title: "OA Desktop",
  url: "views://commits/index.html",
  rpc,
  frame: {
    width: 800,
    height: 800,
    x: 200,
    y: 200,
  },
});

mainWindow.on("close", () => {
  procs.forEach((p) => p.kill());
  Utils.quit();
});

Promise.all([getUserDataDir(), import("node:fs/promises")])
  .then(([userDataDir, fs]) => {
    const logsDir = getLogsDir();
    fs.mkdir(logsDir, { recursive: true }).catch(() => {});
    console.log("OA Electrobun app started:", {
      workingDirectory,
      logsDir,
      userDataDir,
    });
  })
  .catch(console.error);
