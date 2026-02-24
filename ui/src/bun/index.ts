import { BrowserWindow, Utils, Tray, defineElectrobunRPC } from "electrobun/bun";
import path from "node:path";
import net from "node:net";
import fsSync from "node:fs";
import type { MyRPCSchema } from "../shared/rpc.ts";
import {
  uiConfigPath,
  parsedConfig,
  workingDirectory,
  getWorkspaceRoot,
  getLogsDir,
  getUserDataDir,
  getWatchedReposPath,
  getRecentReposPath,
} from "./config.ts";

// Spawn background processes for the OA app
let procs: any[] = [];
let dtuProc: any = null;
let isDtuStarting: boolean = false;
let supervisorProc: any = null;
let activeSupervisorRunId: string | null = null;
import type { FSWatcher } from "node:fs";

let appState = { repoPath: "", commitId: "WORKING_TREE" };
const watchedRepos = new Map<string, { watcher: FSWatcher | null; lastCommit: string }>();

async function saveWatchedRepos() {
  const fs = await import("node:fs/promises");
  const configPath = await getWatchedReposPath();
  const repos = Array.from(watchedRepos.keys());
  try {
    await fs.mkdir(await getUserDataDir(), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(repos, null, 2));
  } catch (e) {
    console.error("Failed to save watched repos:", e);
  }
}

async function enableWatchModeForRepo(repoPath: string) {
  if (watchedRepos.has(repoPath)) {
    return;
  }

  let lastCommit = "";
  try {
    const gitProc = Bun.spawn(["git", "log", "-1", "--format=%H"], { cwd: repoPath });
    const output = await new Response(gitProc.stdout).text();
    lastCommit = output.trim();
  } catch {}

  try {
    const gitDir = path.join(repoPath, ".git");
    const watcher = fsSync.watch(gitDir, { recursive: true }, async (_eventType, filename) => {
      if (
        filename &&
        (filename === "logs/HEAD" || filename === "HEAD" || filename.startsWith("refs/heads/"))
      ) {
        try {
          const gitProc = Bun.spawn(["git", "log", "-1", "--format=%H"], {
            cwd: repoPath,
          });
          const output = await new Response(gitProc.stdout).text();
          const currentCommit = output.trim();
          const watchData = watchedRepos.get(repoPath);

          if (watchData && currentCommit && currentCommit !== watchData.lastCommit) {
            watchData.lastCommit = currentCommit;

            const fsPromises = await import("node:fs/promises");
            const workflowsPath = path.join(repoPath, ".github", "workflows");
            const files = await fsPromises.readdir(workflowsPath, {
              withFileTypes: true,
            });
            let workflowId: string | null = null;
            for (const file of files) {
              if (file.isFile() && (file.name.endsWith(".yml") || file.name.endsWith(".yaml"))) {
                workflowId = file.name;
                break;
              }
            }

            if (workflowId) {
              rpc.send.dtuLog(
                `\n[OA] Auto-Run: New commit ${currentCommit.substring(0, 7)} detected. Running workflow ${workflowId}\n`,
              );
              handleRunWorkflow({ repoPath, workflowId }, (msg) => rpc.send.dtuLog(msg));
            }
          }
        } catch {}
      }
    });

    watchedRepos.set(repoPath, { watcher, lastCommit });
  } catch (e) {
    console.error("Failed to watch .git directory", e);
    // Fallback to null watcher but keep state
    watchedRepos.set(repoPath, { watcher: null, lastCommit });
  }

  await saveWatchedRepos();
}

async function disableWatchModeForRepo(repoPath: string) {
  const watchData = watchedRepos.get(repoPath);
  if (watchData) {
    if (watchData.watcher) {
      watchData.watcher.close();
    }
    watchedRepos.delete(repoPath);
    await saveWatchedRepos();
  }
}

async function handleRunWorkflow(
  { repoPath, workflowId }: { repoPath: string; workflowId: string },
  sendLog: (msg: string) => void,
) {
  if (supervisorProc) {
    supervisorProc.kill();
    supervisorProc = null;
    activeSupervisorRunId = null;
  }

  const workflowsPath = path.join(repoPath, ".github", "workflows");
  const fullPath = path.join(workflowsPath, workflowId);

  sendLog(`\n[OA] Starting workflow run: ${workflowId} in ${repoPath}\n`);

  try {
    const spawnArgs = [
      "pnpm",
      "--filter",
      "supervisor",
      "run",
      "oa",
      "run",
      "--workflow",
      fullPath,
    ];
    if (uiConfigPath) {
      spawnArgs.push("--config", uiConfigPath);
    }

    supervisorProc = Bun.spawn(spawnArgs, {
      cwd: getWorkspaceRoot(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const currentProc = supervisorProc;
    procs.push(supervisorProc);

    currentProc.exited
      .then(() => {
        if (supervisorProc === currentProc) {
          supervisorProc = null;
          activeSupervisorRunId = null;
        }
      })
      .catch(() => {});

    let runIdResolved = false;
    let resolveRunId: (id: string | null) => void;
    const runIdPromise = new Promise<string | null>((r) => (resolveRunId = r));

    const readOutput = async (stream: ReadableStream | null) => {
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
        const text = decoder.decode(value);

        if (!runIdResolved) {
          const match = text.match(/(oa-runner-\d+)/);
          if (match) {
            runIdResolved = true;
            activeSupervisorRunId = match[1];
            resolveRunId(match[1]);
          }
        }

        sendLog(text);
      }
    };

    readOutput(supervisorProc.stdout);
    readOutput(supervisorProc.stderr);

    setTimeout(() => {
      if (!runIdResolved) {
        resolveRunId(null);
      }
    }, 5000);

    return await runIdPromise;
  } catch (e) {
    console.error("Failed to run workflow:", e);
    sendLog(`[OA] Failed to run workflow: ${(e as Error).message}\n`);
    return null;
  }
}

async function doLaunchDTU() {
  if (dtuProc) {
    return true;
  }
  console.log("Starting DTU server...");
  isDtuStarting = true;
  try {
    const spawnArgs = ["pnpm", "--filter", "dtu-github-actions", "dev"];
    if (uiConfigPath) {
      spawnArgs.push("--config", uiConfigPath);
    }

    dtuProc = Bun.spawn(spawnArgs, {
      cwd: getWorkspaceRoot(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(dtuProc);

    const readOutput = async (stream: ReadableStream | null) => {
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
        const text = decoder.decode(value);
        console.log("[DTU Output] ", text);
        // Use the global rpc object directly to send to attached webviews
        rpc.send.dtuLog(text);
      }
    };

    readOutput(dtuProc.stdout);
    readOutput(dtuProc.stderr);

    // Poll port 8910 until it becomes available
    const start = Date.now();
    let isOnline = false;
    while (Date.now() - start < 10000) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(250);
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("timeout", () => {
            socket.destroy();
            reject(new Error("timeout"));
          });
          socket.once("error", (err) => {
            socket.destroy();
            reject(err);
          });
          socket.connect(8910, "127.0.0.1");
        });
        isOnline = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (!isOnline) {
      dtuProc.kill();
      dtuProc = null;
      isDtuStarting = false;
      return false;
    }

    isDtuStarting = false;
    return true;
  } catch (e) {
    console.error("Failed to start DTU:", e);
    isDtuStarting = false;
    return false;
  }
}

async function loadWatchedRepos() {
  const fs = await import("node:fs/promises");
  const configPath = await getWatchedReposPath();
  try {
    const content = await fs.readFile(configPath, "utf-8");
    const repos = JSON.parse(content) as string[];
    for (const repoPath of repos) {
      await enableWatchModeForRepo(repoPath);
    }
  } catch {
    // file doesn't exist
  }
}

async function startBackgroundProcesses() {
  // Supervisor can be started here or later through similar buttons if needed
  await doLaunchDTU();
  await loadWatchedRepos();
}

// startBackgroundProcesses() moved below rpc

const rpc = defineElectrobunRPC<MyRPCSchema, "bun">("bun", {
  handlers: {
    requests: {
      launchDTU: async () => {
        return await doLaunchDTU();
      },
      stopDTU: async () => {
        if (dtuProc) {
          dtuProc.kill();
          procs = procs.filter((p) => p !== dtuProc);
          dtuProc = null;
        }
        return true;
      },
      getDtuStatus: async () => {
        if (isDtuStarting) {
          return "Starting";
        }
        return dtuProc !== null ? "Running" : "Stopped";
      },
      getAppState: async () => appState,
      setAppState: async (params) => {
        if (params.repoPath !== undefined) {
          appState.repoPath = params.repoPath;
        }
        if (params.commitId !== undefined) {
          appState.commitId = params.commitId;
        }
      },
      getRecentRepos: async () => {
        const fs = await import("node:fs/promises");
        const configPath = await getRecentReposPath();
        try {
          const content = await fs.readFile(configPath, "utf-8");
          return JSON.parse(content) as string[];
        } catch {
          return [];
        }
      },
      selectRepo: async () => {
        const paths = await Utils.openFileDialog({
          canChooseFiles: false,
          canChooseDirectory: true,
          allowsMultipleSelection: false,
        });
        if (paths && paths.length > 0) {
          const selectedPath = paths[0];

          // Add to recent repos
          const fs = await import("node:fs/promises");
          const configDir = await getUserDataDir();
          const configPath = await getRecentReposPath();

          let recent: string[] = [];
          try {
            await fs.mkdir(configDir, { recursive: true });
            try {
              const content = await fs.readFile(configPath, "utf-8");
              recent = JSON.parse(content);
            } catch {
              // file doesn't exist or invalid json
            }

            // Deduplicate and move to front
            recent = [selectedPath, ...recent.filter((p) => p !== selectedPath)].slice(0, 10);
            await fs.writeFile(configPath, JSON.stringify(recent, null, 2));
          } catch (e) {
            console.error("Failed to save recent repos:", e);
          }

          return selectedPath;
        }
        return null;
      },
      getWorkflows: async ({ repoPath }) => {
        const fs = await import("node:fs/promises");
        const workflowsPath = path.join(repoPath, ".github", "workflows");
        const workflows: { id: string; name: string }[] = [];

        try {
          const files = await fs.readdir(workflowsPath, { withFileTypes: true });
          for (const file of files) {
            if (file.isFile() && (file.name.endsWith(".yml") || file.name.endsWith(".yaml"))) {
              const fullPath = path.join(workflowsPath, file.name);
              const content = await fs.readFile(fullPath, "utf-8");
              const nameMatch = content.match(/^name:\s*(.+)$/m);
              const name = nameMatch ? nameMatch[1].trim() : file.name;
              workflows.push({ id: file.name, name });
            }
          }
        } catch (e) {
          console.error("Failed to read workflows", e);
        }

        return workflows;
      },
      getRunOnCommitEnabled: async ({ repoPath }) => {
        return watchedRepos.has(repoPath);
      },
      toggleRunOnCommit: async ({ repoPath, enabled }) => {
        if (enabled) {
          await enableWatchModeForRepo(repoPath);
        } else {
          await disableWatchModeForRepo(repoPath);
        }
      },
      runWorkflow: async ({ repoPath, workflowId }) => {
        return await handleRunWorkflow({ repoPath, workflowId }, (msg) => rpc.send.dtuLog(msg));
      },
      stopWorkflow: async () => {
        if (supervisorProc) {
          rpc.send.dtuLog(`\n[OA] Stopping workflow run...\n`);
          supervisorProc.kill();
          procs = procs.filter((p) => p !== supervisorProc);
          supervisorProc = null;
          activeSupervisorRunId = null;
          return true;
        }
        return false;
      },
      getRunCommits: async ({ repoPath: _repoPath }) => {
        const fs = await import("node:fs/promises");
        const logsDir = getLogsDir();
        try {
          const files = await fs.readdir(logsDir, { withFileTypes: true });
          const commitsMap = new Map<string, { id: string; label: string; date: number }>();

          for (const file of files) {
            if (file.isDirectory() && file.name.startsWith("oa-runner-")) {
              const runDir = path.join(logsDir, file.name);
              const outputLogPath = path.join(runDir, "output.log");
              try {
                const stat = await fs.stat(outputLogPath);
                const content = await fs.readFile(outputLogPath, "utf-8");

                // e.g. "Using: SHA abc1234 (HEAD) · oa-runner-1"
                // or "Using: working directory (dirty files included) · oa-runner-2"
                let commitId = "WORKING_TREE";
                let label = "Working Tree";

                const shaMatch = content.match(/Using: SHA ([a-f0-9]+)/);
                if (shaMatch) {
                  commitId = shaMatch[1];
                  label = `Commit ${commitId.substring(0, 7)}`;
                }

                const existing = commitsMap.get(commitId);
                const modifiedTime = stat.mtimeMs;
                if (!existing || modifiedTime > existing.date) {
                  commitsMap.set(commitId, { id: commitId, label, date: modifiedTime });
                }
              } catch {
                // Ignore incomplete or missing logs
              }
            }
          }

          return Array.from(commitsMap.values()).sort((a, b) => b.date - a.date);
        } catch (e: any) {
          if (e.code !== "ENOENT") {
            console.error("Failed to read runs logs dir", e);
          }
          return [];
        }
      },
      getWorkflowsForCommit: async ({ repoPath: _repoPath, commitId }) => {
        const fs = await import("node:fs/promises");
        const logsDir = getLogsDir();
        const results: {
          runId: string;
          workflowName: string;
          status: "Passed" | "Failed" | "Running" | "Unknown";
          date: number;
        }[] = [];

        try {
          const files = await fs.readdir(logsDir, { withFileTypes: true });
          for (const file of files) {
            if (file.isDirectory() && file.name.startsWith("oa-runner-")) {
              const runDir = path.join(logsDir, file.name);
              const outputLogPath = path.join(runDir, "output.log");
              const metadataPath = path.join(runDir, "metadata.json");
              try {
                const content = await fs.readFile(outputLogPath, "utf-8");
                const stat = await fs.stat(outputLogPath);

                const isWorkingTree = content.includes("working directory");
                const shaMatch = content.match(/Using: SHA ([a-f0-9]+)/);

                const fileCommitId = shaMatch ? shaMatch[1] : isWorkingTree ? "WORKING_TREE" : null;

                if (fileCommitId === commitId) {
                  let workflowName = "Unknown Workflow";
                  try {
                    const metaContent = await fs.readFile(metadataPath, "utf-8");
                    const meta = JSON.parse(metaContent);
                    workflowName = meta.workflowName || workflowName;
                  } catch {
                    // Ignore metadata parsing errors
                  }

                  let status: "Passed" | "Failed" | "Running" | "Unknown" = "Unknown";
                  if (activeSupervisorRunId === file.name) {
                    status = "Running";
                  } else if (content.includes("Job succeeded")) {
                    status = "Passed";
                  } else if (content.includes("Job failed") || content.match(/✖ Job /)) {
                    status = "Failed";
                  }

                  results.push({
                    runId: file.name,
                    workflowName,
                    status,
                    date: stat.mtimeMs,
                  });
                }
              } catch {}
            }
          }
          return results.sort((a, b) => b.date - a.date);
        } catch {
          return [];
        }
      },
      getRunDetails: async ({ runId }) => {
        const fs = await import("node:fs/promises");
        const outputLogPath = path.join(getLogsDir(), runId, "output.log");
        try {
          const logs = await fs.readFile(outputLogPath, "utf-8");
          let status: "Passed" | "Failed" | "Running" | "Unknown" = "Unknown";
          if (activeSupervisorRunId === runId) {
            status = "Running";
          } else if (logs.includes("Job succeeded")) {
            status = "Passed";
          } else if (logs.includes("Job failed") || logs.match(/✖ Job /)) {
            status = "Failed";
          }
          return { logs, status };
        } catch {
          return null;
        }
      },
    },
  },
});

// Now that RPC is defined, safely start background processes.
startBackgroundProcesses();

// In electrobun, main.js runs in Contents/MacOS/../Resources
// Our asset config copies the image to the app/assets folder.
const trayIconPath = path.join(import.meta.dirname, "../assets/tray.png");
console.log("Resolved tray icon path: ", trayIconPath);

// import { type MenuItemConfig } from "electrobun/bun";

// // Define the menu structure
// const _trayMenu: MenuItemConfig[] = [
//   { label: "Status: Online", type: "normal", enabled: false }, // Explicit "normal" type fixes TS strict checks
//   { type: "divider" },
//   { label: "Quit", type: "normal", action: "quit-app" },
// ];

// Create a system tray notification/icon
const tray = new Tray({
  title: "OA",
  image: trayIconPath,
  template: true, // Turn off template mode to allow standard colored PNGs
});

// The setMenu must be called explicitly to map the config into the native layer
// (some versions of electrobun drop the menu arg from the Tray constructor)
// Commented out temporarily to test direct icon clicks!
// tray.setMenu(_trayMenu);

tray.on("tray-clicked", (e: any) => {
  if (e.data?.action === "quit-app") {
    procs.forEach((p) => p.kill());
    Utils.quit();
  }
});

// Create the main application window
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

// Quit the app when the main window is closed
mainWindow.on("close", () => {
  procs.forEach((p) => p.kill());
  Utils.quit();
});

// Note: We cannot await top-level async functions directly unless we enclose them or top-level await is enabled.
// Thus, using a self-executing async function or promising handling.
Promise.all([getUserDataDir(), import("node:fs/promises")])
  .then(([userDataDir, fs]) => {
    // Pre-emptively create logs directory to avoid ENOENT scandir errors
    const logsDir = getLogsDir();
    fs.mkdir(logsDir, { recursive: true }).catch((e) => {
      console.error("Failed to pre-create logs dir:", e);
    });

    console.log("process.argv is: ", process.argv);
    console.log("OA Electrobun app started with config:", {
      uiConfigPath,
      workingDirectory,
      parsedConfig,
      logsDir,
      userDataDir,
    });
  })
  .catch(console.error);
