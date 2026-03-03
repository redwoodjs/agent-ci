import { BrowserWindow, Utils, Tray, defineElectrobunRPC } from "electrobun/bun";
import path from "node:path";
import type { MyRPCSchema } from "../shared/rpc.ts";
import {
  uiConfigPath,
  parsedConfig,
  workingDirectory,
  getWorkspaceRoot,
  getLogsDir,
  getUserDataDir,
} from "./config.ts";

let procs: any[] = [];
let trayInstance: Tray | null = null;
let currentTrayStatus: "Idle" | "Pending" | "Running" | "Passed" | "Failed" = "Idle";

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
  if (uiConfigPath) {
    spawnArgs.push("--config", uiConfigPath);
  }

  const supervisorProc = Bun.spawn(spawnArgs, {
    cwd: getWorkspaceRoot(),
    env: process.env,
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
    const runId = e.data.data.runId;
    // Set the UI state so the runs page knows which run to display
    try {
      await fetch("http://localhost:8912/ui-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
    } catch (err) {
      console.error("Failed to set ui-state for run navigation", err);
    }
    // Navigate the main window to the runs page
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
  url: "views://repos/index.html",
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
    console.log("OA Electrobun app started with config:", {
      uiConfigPath,
      workingDirectory,
      parsedConfig,
      logsDir,
      userDataDir,
    });
  })
  .catch(console.error);
