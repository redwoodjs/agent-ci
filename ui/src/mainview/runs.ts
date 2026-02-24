import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";
let commitId = "";
let workflowId = "";

let activeRunId: string | null = null;
let isStreamingLogs = false;

// UI Elements
const backBtn = document.getElementById("back-btn");
const workflowLabel = document.getElementById("workflow-label");
const runsList = document.getElementById("runs-list");
const logsViewer = document.getElementById("logs-viewer");
const runTitle = document.getElementById("run-title");
const runStatus = document.getElementById("run-status");
const stopRunBtn = document.getElementById("stop-run-btn");
const runNowBtn = document.getElementById("run-now-btn");

async function loadHistory() {
  if (!runsList) {
    return;
  }
  const history = await rpc.request.getWorkflowsForCommit({ repoPath, commitId });

  // Filter history by the current workflowId
  // The current API filters by commitId, but we want runs for THIS workflow specifically.
  // Note: getWorkflowsForCommit returns workflowName, but we might need workflowId.
  // Assuming workflowName in history matches workflowId's name or we can filter by it.

  const filteredHistory = history.filter((run) => {
    const cleanWfId = workflowId.replace(/\.yml|\.yaml/, "");
    return run.workflowName === cleanWfId || run.workflowName === workflowId;
  });

  if (filteredHistory.length > 0) {
    runsList.innerHTML = "";
    filteredHistory.forEach((run) => {
      const item = document.createElement("div");
      item.className = "list-item";

      const titleWrapper = document.createElement("div");
      const title = document.createElement("div");
      title.className = "list-item-title";
      title.innerText = run.runId;

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
      runsList.appendChild(item);
    });
  } else {
    runsList.innerHTML = `<div style="color: var(--text-secondary); padding: 8px;">No previous runs for this workflow. Click "Run Now" to start one.</div>`;
  }
}

async function selectRun(runId: string, workflowName: string) {
  activeRunId = runId;
  isStreamingLogs = false;

  if (runTitle) {
    runTitle.innerText = `${workflowName} (${runId})`;
  }
  if (logsViewer) {
    logsViewer.innerText = "Loading logs...";
  }

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

    logsViewer.scrollTop = logsViewer.scrollHeight;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = await rpc.request.getAppState();
  repoPath = state.repoPath;
  commitId = state.commitId;
  workflowId = state.workflowId;

  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }
  if (workflowLabel) {
    workflowLabel.innerText = `${workflowId} @ ${commitId === "WORKING_TREE" ? "Working Tree" : commitId.substring(0, 7)}`;
  }

  if (stopRunBtn) {
    stopRunBtn.addEventListener("click", async () => {
      stopRunBtn.setAttribute("disabled", "true");
      await rpc.request.stopWorkflow();
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
    });
  }

  if (runNowBtn) {
    runNowBtn.addEventListener("click", async () => {
      runNowBtn.setAttribute("disabled", "true");
      if (logsViewer) {
        logsViewer.innerText = "Starting workflow run...\n";
        runTitle!.innerText = workflowId;
        runStatus!.innerText = "Running";
        runStatus!.className = "status-badge status-Running";
        runStatus!.style.display = "inline-block";
        stopRunBtn!.style.display = "inline-flex";
      }

      isStreamingLogs = true;
      const newRunId = await rpc.request.runWorkflow({ repoPath, workflowId, commitId });
      runNowBtn.removeAttribute("disabled");

      if (newRunId) {
        activeRunId = newRunId;
      }
      await loadHistory();
    });
  }

  loadHistory();

  setInterval(() => {
    if (repoPath && commitId && workflowId) {
      loadHistory();
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
