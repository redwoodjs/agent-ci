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
let currentTrayStatus: "Idle" | "Running" | "Passed" | "Failed" = "Idle";

function updateTrayStatus(status: "Idle" | "Running" | "Passed" | "Failed") {
  if (!trayInstance || currentTrayStatus === status) {
    return;
  }
  currentTrayStatus = status;
  const basePath = path.join(import.meta.dirname, "../assets");
  let imgPath = path.join(basePath, "tray-idle.png");
  if (status === "Running") {
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

  // Use SSE events to update tray icon instead of polling
  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "runStarted" || data.type === "runFinished") {
          const res = await fetch("http://localhost:8912/status");
          const statusData = await res.json();
          if (statusData && statusData.status) {
            updateTrayStatus(statusData.status);
          }
        }
      } catch {}
    });
    evtSource.addEventListener("error", () => {
      updateTrayStatus("Idle");
    });
  } catch {
    updateTrayStatus("Idle");
  }
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

tray.on("tray-clicked", (e: any) => {
  if (e.data?.action === "quit-app") {
    procs.forEach((p) => p.kill());
    Utils.quit();
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
