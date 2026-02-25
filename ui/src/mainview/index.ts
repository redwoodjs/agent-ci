import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: {
    requests: {},
    messages: {},
  },
});

new ElectrobunView.Electroview({ rpc });

console.log("Hello Electrobun view loaded!");

const logsEl = document.getElementById("dtu-logs");

rpc.addMessageListener("dtuLog", (log: string) => {
  if (logsEl) {
    const isAtBottom = logsEl.scrollHeight - logsEl.scrollTop - logsEl.clientHeight < 10;
    if (logsEl.innerText === "Waiting for DTU logs...\n") {
      logsEl.innerText = "";
    }
    logsEl.innerText += log;
    if (isAtBottom) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }
});

const launchBtn = document.getElementById("launch-dtu-btn");
const statusEl = document.getElementById("dtu-status");

if (launchBtn && statusEl) {
  let isRunning = false;

  async function performLaunch() {
    launchBtn!.setAttribute("disabled", "true");
    statusEl!.innerText = "Starting...";
    statusEl!.style.color = "orange";

    try {
      const success = await rpc.request.launchDTU();
      if (success) {
        isRunning = true;
        statusEl!.innerText = "Online";
        statusEl!.style.color = "lightgreen";
        launchBtn!.innerText = "Stop DTU";
      } else {
        statusEl!.innerText = "Failed";
        statusEl!.style.color = "red";
      }
    } catch (e) {
      console.error("Error launching DTU:", e);
      statusEl!.innerText = "Error";
      statusEl!.style.color = "red";
    } finally {
      launchBtn!.removeAttribute("disabled");
    }
  }

  async function performStop() {
    launchBtn!.setAttribute("disabled", "true");
    statusEl!.innerText = "Stopping...";
    statusEl!.style.color = "orange";

    try {
      const success = await rpc.request.stopDTU();
      if (success) {
        isRunning = false;
        statusEl!.innerText = "Offline";
        statusEl!.style.color = "#888";
        launchBtn!.innerText = "Launch DTU";
      } else {
        statusEl!.innerText = "Error";
        statusEl!.style.color = "red";
      }
    } catch (e) {
      console.error("Error stopping DTU:", e);
      statusEl!.innerText = "Error";
      statusEl!.style.color = "red";
    } finally {
      launchBtn!.removeAttribute("disabled");
    }
  }

  launchBtn.addEventListener("click", async () => {
    if (isRunning) {
      await performStop();
    } else {
      await performLaunch();
    }
  });

  // Auto-start DTU on load
  performLaunch();
}

const selectRepoBtn = document.getElementById("select-repo-btn");
const repoPathDisplay = document.getElementById("repo-path-display");
const workflowsList = document.getElementById("workflows-list");
const recentReposList = document.getElementById("recent-repos-list");
const stopWorkflowBtn = document.getElementById("stop-workflow-btn");

// Helper to manage the Stop Workflow button state
function setStopButtonState(active: boolean) {
  if (!stopWorkflowBtn) {
    return;
  }
  if (active) {
    stopWorkflowBtn.removeAttribute("disabled");
    stopWorkflowBtn.style.cursor = "pointer";
    stopWorkflowBtn.style.opacity = "1";
    stopWorkflowBtn.innerText = "Stop Workflow";
  } else {
    stopWorkflowBtn.setAttribute("disabled", "true");
    stopWorkflowBtn.style.cursor = "not-allowed";
    stopWorkflowBtn.style.opacity = "0.5";
    stopWorkflowBtn.innerText = "Stop Workflow";
  }
}

// Wire up the Stop Workflow button
if (stopWorkflowBtn) {
  stopWorkflowBtn.addEventListener("click", async () => {
    setStopButtonState(false);
    if (stopWorkflowBtn) {
      stopWorkflowBtn.innerText = "Stopping...";
    }
    try {
      await rpc.request.stopWorkflow();
    } catch (e) {
      console.error("Failed to stop workflow:", e);
      setStopButtonState(true);
    }
  });
}

// Helper to load workflows directly
async function loadWorkflows(repoPath: string) {
  if (!repoPathDisplay || !workflowsList) {
    return;
  }

  repoPathDisplay.innerText = repoPath;
  repoPathDisplay.style.color = "lightgreen";

  workflowsList.innerHTML = `<div style="color: #888;">Loading workflows...</div>`;
  const workflows = await rpc.request.getWorkflows({ repoPath });

  if (workflows.length > 0) {
    workflowsList.innerHTML = "";
    workflows.forEach((wf) => {
      const wfEl = document.createElement("div");
      wfEl.style.padding = "10px";
      wfEl.style.background = "#2a2a2a";
      wfEl.style.borderRadius = "4px";
      wfEl.style.cursor = "pointer";
      wfEl.innerText = `${wf.name} (${wf.id})`;

      // Hover styling
      wfEl.addEventListener("mouseenter", () => {
        wfEl.style.background = "#3a3a3a";
      });
      wfEl.addEventListener("mouseleave", () => {
        wfEl.style.background = "#2a2a2a";
      });

      // Run workflow on click
      wfEl.addEventListener("click", async () => {
        if (logsEl) {
          logsEl.innerText = "Starting workflow...\n";
        }
        setStopButtonState(true);
        try {
          const success = await rpc.request.runWorkflow({ repoPath, workflowId: wf.id });
          if (!success) {
            setStopButtonState(false);
            if (logsEl) {
              logsEl.innerText += "\n[OA] Workflow run failed to start.";
            }
          }
        } catch (e) {
          console.error("Error starting workflow:", e);
          setStopButtonState(false);
        }
      });

      workflowsList.appendChild(wfEl);
    });
  } else {
    workflowsList.innerHTML = `<div style="color: orange;">No workflows found in .github/workflows</div>`;
  }
}

// Helper to load and render the recent repos list
async function loadRecentRepos() {
  if (!recentReposList) {
    return;
  }

  // Get recent repos
  const recent = await rpc.request.getRecentRepos();
  if (recent.length > 0) {
    recentReposList.innerHTML = "";
    recent.forEach((repoPath) => {
      const projEl = document.createElement("div");
      projEl.style.padding = "10px";
      projEl.style.background = "#2a2a2a";
      projEl.style.borderRadius = "4px";
      projEl.style.cursor = "pointer";
      projEl.style.wordBreak = "break-all";
      projEl.innerText = repoPath;

      // On hover styling
      projEl.addEventListener("mouseenter", () => {
        projEl.style.background = "#3a3a3a";
      });
      projEl.addEventListener("mouseleave", () => {
        projEl.style.background = "#2a2a2a";
      });

      // Click to load repo
      projEl.addEventListener("click", () => {
        loadWorkflows(repoPath);
      });

      recentReposList.appendChild(projEl);
    });
  } else {
    recentReposList.innerHTML = `<div style="color: #666; font-style: italic">No recent repos</div>`;
  }
}

// Initial load
loadRecentRepos();

if (selectRepoBtn && repoPathDisplay && workflowsList) {
  selectRepoBtn.addEventListener("click", async () => {
    selectRepoBtn.setAttribute("disabled", "true");
    try {
      const selectedPath = await rpc.request.selectRepo();
      if (selectedPath) {
        await loadWorkflows(selectedPath);
        // Refresh the recent repos list
        await loadRecentRepos();
      }
    } catch (e) {
      console.error("Error selecting repo:", e);
    } finally {
      selectRepoBtn.removeAttribute("disabled");
    }
  });
}
