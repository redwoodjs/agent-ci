import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let activeRunId: string | null = null;
let isStreamingLogs = false;

// UI Elements
const backBtn = document.getElementById("back-btn");
const workflowLabel = document.getElementById("workflow-label");
const logsViewer = document.getElementById("logs-viewer");
const runTitle = document.getElementById("run-title");
const runStatus = document.getElementById("run-status");
const stopRunBtn = document.getElementById("stop-run-btn");

async function loadLogs() {
  if (!activeRunId) {
    return;
  }

  if (runTitle) {
    runTitle.innerText = `Logs for ${activeRunId}`;
  }

  const details = await rpc.request.getRunDetails({ runId: activeRunId });
  if (details && logsViewer && runStatus) {
    // Only update logs if not actively streaming (otherwise it fights with the stream)
    if (!isStreamingLogs) {
      logsViewer.innerText = details.logs;
      logsViewer.scrollTop = logsViewer.scrollHeight;
    }

    if (runStatus.innerText !== details.status) {
      runStatus.innerText = details.status;
      runStatus.className = `status-badge status-${details.status}`;
      runStatus.style.display = "inline-block";
    }

    if (details.status === "Running" && stopRunBtn) {
      stopRunBtn.style.display = "inline-flex";
    } else if (stopRunBtn) {
      stopRunBtn.style.display = "none";
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = await rpc.request.getAppState();
  activeRunId = state.runId;

  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  if (workflowLabel) {
    workflowLabel.innerText = `Run ${activeRunId || "Unknown"}`;
  }

  if (stopRunBtn) {
    stopRunBtn.addEventListener("click", async () => {
      stopRunBtn.setAttribute("disabled", "true");
      await rpc.request.stopWorkflow();
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
      await loadLogs();
    });
  }

  const details = await rpc.request.getRunDetails({ runId: activeRunId });
  if (details?.status === "Running") {
    isStreamingLogs = true;
  }

  await loadLogs();

  setInterval(async () => {
    if (activeRunId) {
      const currentDetails = await rpc.request.getRunDetails({ runId: activeRunId });
      if (currentDetails?.status !== "Running") {
        isStreamingLogs = false; // It stopped, so we can poll the full file
      }
      await loadLogs();
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
  if (isStreamingLogs && logsViewer && activeRunId) {
    // Only append if it's the active run (assumes the backend is sending logs for the active run)
    logsViewer.innerText += log;
    logsViewer.scrollTop = logsViewer.scrollHeight;
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
