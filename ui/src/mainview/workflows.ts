import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";
let commitId = "WORKING_TREE";

let activeRunId: string | null = null;
let isStreamingLogs = false;
// Polling setup will be done in DOMContentLoaded

// UI Elements
const backBtn = document.getElementById("back-btn");
const commitLabel = document.getElementById("commit-label");
const workflowsList = document.getElementById("workflows-list");
const availableWorkflowsList = document.getElementById("available-workflows");
const logsViewer = document.getElementById("logs-viewer");
const runTitle = document.getElementById("run-title");
const runStatus = document.getElementById("run-status");
const stopRunBtn = document.getElementById("stop-run-btn");

function getCommitLabel(id: string) {
  if (id === "WORKING_TREE") {
    return "Working Tree";
  }
  return `Commit ${id.substring(0, 7)}`;
}

async function loadHistory() {
  if (!workflowsList) {
    return;
  }
  const history = await rpc.request.getWorkflowsForCommit({ repoPath, commitId });

  if (history.length > 0) {
    workflowsList.innerHTML = "";
    history.forEach((run) => {
      const item = document.createElement("div");
      item.className = "list-item";

      const titleWrapper = document.createElement("div");
      const title = document.createElement("div");
      title.className = "list-item-title";
      title.innerText = run.workflowName;

      const sub = document.createElement("div");
      sub.className = "list-item-subtitle";
      sub.innerText = new Date(run.date).toLocaleString();

      titleWrapper.appendChild(title);
      titleWrapper.appendChild(sub);

      const statusBadge = document.createElement("div");
      statusBadge.className = `status-badge status-${run.status}`;
      statusBadge.innerText = run.status;

      item.appendChild(titleWrapper);
      item.appendChild(statusBadge);

      item.addEventListener("click", () => selectRun(run.runId, run.workflowName));
      workflowsList.appendChild(item);
    });
  } else {
    workflowsList.innerHTML = `<div style="color: var(--text-secondary); padding: 8px;">No previous runs for this context. Select a workflow from below to start one.</div>`;
  }
}

async function selectRun(runId: string, workflowName: string) {
  activeRunId = runId;
  isStreamingLogs = false; // Disable stream log pushing

  if (runTitle) {
    runTitle.innerText = `${workflowName} (${runId})`;
  }
  if (logsViewer) {
    logsViewer.innerText = "Loading logs...";
  }

  // Polling for status directly from RPC
  const details = await rpc.request.getRunDetails({ runId });
  if (details && logsViewer && runStatus) {
    logsViewer.innerText = details.logs;
    runStatus.innerText = details.status;
    runStatus.className = `status-badge status-${details.status}`;
    runStatus.style.display = "inline-block";

    if (details.status === "Running" && stopRunBtn) {
      stopRunBtn.style.display = "inline-flex";
    } else if (stopRunBtn) {
      stopRunBtn.style.display = "none";
    }

    // Smooth scroll to bottom on initial load
    logsViewer.scrollTop = logsViewer.scrollHeight;
  }
}

async function loadAvailableWorkflows() {
  if (!availableWorkflowsList) {
    return;
  }
  const workflows = await rpc.request.getWorkflows({ repoPath });
  if (workflows.length > 0) {
    availableWorkflowsList.innerHTML = "";
    workflows.forEach((wf) => {
      const button = document.createElement("button");
      button.className = "btn";
      button.style.justifyContent = "flex-start";
      button.innerText = `▶ ${wf.name}`;

      button.addEventListener("click", async () => {
        button.setAttribute("disabled", "true");
        if (logsViewer) {
          logsViewer.innerText = "Starting workflow run...\n";
          runTitle!.innerText = wf.name;
          runStatus!.innerText = "Running";
          runStatus!.className = "status-badge status-Running";
          runStatus!.style.display = "inline-block";
          stopRunBtn!.style.display = "inline-flex";
        }

        isStreamingLogs = true;
        const newRunId = await rpc.request.runWorkflow({ repoPath, workflowId: wf.id });
        button.removeAttribute("disabled");

        if (newRunId) {
          activeRunId = newRunId;
        }
        // Refresh history to see the new item
        await loadHistory();
      });

      availableWorkflowsList.appendChild(button);
    });
  } else {
    availableWorkflowsList.innerHTML = `<div style="color: var(--text-secondary);">No workflows found.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = await rpc.request.getAppState();
  repoPath = state.repoPath;
  commitId = state.commitId;

  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }
  if (commitLabel) {
    commitLabel.innerText = getCommitLabel(commitId);
  }

  if (stopRunBtn) {
    stopRunBtn.addEventListener("click", async () => {
      stopRunBtn.setAttribute("disabled", "true");
      await rpc.request.stopWorkflow();
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
    });
  }

  loadHistory();
  loadAvailableWorkflows();

  // Refresh history every few seconds to see runs from elsewhere or status updates
  setInterval(() => {
    if (repoPath && commitId) {
      loadHistory();
      // Also poll the current run if it's running
      if (activeRunId && !isStreamingLogs) {
        rpc.request.getRunDetails({ runId: activeRunId }).then((details) => {
          if (details && runStatus) {
            if (runStatus.innerText !== details.status) {
              runStatus.innerText = details.status;
              runStatus.className = `status-badge status-${details.status}`;
            }
            if (details.status !== "Running" && stopRunBtn) {
              stopRunBtn.style.display = "none";
            }
          }
        });
      }
    }
  }, 3000);

  const dtuStatusEl = document.getElementById("dtu-status");
  const pollDtuStatus = async () => {
    if (!dtuStatusEl) {
      return;
    }
    const status = await rpc.request.getDtuStatus();
    if (status === "Running") {
      dtuStatusEl.innerText = "DTU: Running";
      dtuStatusEl.className = "status-badge status-Passed";
    } else if (status === "Starting") {
      dtuStatusEl.innerText = "DTU: Starting...";
      dtuStatusEl.className = "status-badge status-Running";
    } else {
      dtuStatusEl.innerText = "DTU: Stopped (Click to Start)";
      dtuStatusEl.className = "status-badge status-Failed";
    }
  };

  if (dtuStatusEl) {
    dtuStatusEl.addEventListener("click", async () => {
      const status = await rpc.request.getDtuStatus();
      if (status === "Stopped") {
        dtuStatusEl.innerText = "DTU: Starting...";
        dtuStatusEl.className = "status-badge status-Running";
        await rpc.request.launchDTU();
        await pollDtuStatus();
      } else if (status === "Running") {
        dtuStatusEl.innerText = "DTU: Stopping...";
        dtuStatusEl.className = "status-badge status-Running";
        await rpc.request.stopDTU();
        await pollDtuStatus();
      }
    });
    pollDtuStatus();
    setInterval(pollDtuStatus, 3000);
  }
});

rpc.addMessageListener("dtuLog", (log: string) => {
  if (isStreamingLogs && logsViewer) {
    logsViewer.innerText += log;
    logsViewer.scrollTop = logsViewer.scrollHeight;
  }
});

// Global escape listener
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
