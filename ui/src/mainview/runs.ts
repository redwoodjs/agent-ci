import { getAppState, getAppStateAsync } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { AnsiUp } from "ansi_up";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";

const ansiUp = new AnsiUp();

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

  const details = await fetch(
    "http://localhost:8912/runs?runId=" + encodeURIComponent(activeRunId),
  ).then((r) => r.json());
  const status = details.status || "Unknown";
  if (details && logsViewer && runStatus) {
    // Fetch log content when not actively streaming
    if (!isStreamingLogs) {
      try {
        const logs = await fetch(
          "http://localhost:8912/runs/logs?runId=" + encodeURIComponent(activeRunId),
        ).then((r) => r.text());
        if (logs) {
          const isAtBottom =
            logsViewer.scrollHeight - logsViewer.scrollTop - logsViewer.clientHeight < 10;
          logsViewer.innerHTML = "<pre>" + ansiUp.ansi_to_html(logs) + "</pre>";
          if (isAtBottom) {
            logsViewer.scrollTop = logsViewer.scrollHeight;
          }
        } else {
          logsViewer.innerHTML = `<span style="color: var(--text-secondary)">Waiting for logs...</span>`;
        }
      } catch {
        logsViewer.innerHTML = `<span style="color: var(--text-secondary)">No logs available</span>`;
      }
    }

    if (runStatus.innerText !== status) {
      runStatus.innerText = status;
      runStatus.className = `status-badge status-${status}`;
      runStatus.style.display = "inline-block";
    }

    if (status === "Running" && stopRunBtn) {
      stopRunBtn.style.display = "inline-flex";
    } else if (stopRunBtn) {
      stopRunBtn.style.display = "none";
    }
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();
  const state = await getAppStateAsync();
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
      await fetch("http://localhost:8912/workflows/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: getAppState().runId }),
      });
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
      await loadLogs();
    });
  }

  const initDetails = await fetch(
    "http://localhost:8912/runs?runId=" + encodeURIComponent(activeRunId || ""),
  ).then((r) => r.json());
  if (initDetails?.status === "Running") {
    isStreamingLogs = true;
  }

  await loadLogs();

  const dtuStatusEl = document.getElementById("dtu-status");
  const pollDtuStatus = async () => {
    if (!dtuStatusEl) {
      return;
    }

    let dtuStatus = "Stopped";
    try {
      const res = await fetch("http://localhost:8912/dtu");
      if (res.ok) {
        const data = await res.json();
        dtuStatus = data.status;
      }
    } catch {
      dtuStatus = "Error";
    }

    if (dtuStatus === "Running") {
      dtuStatusEl.innerText = "DTU: Running";
      dtuStatusEl.className = "status-badge status-Passed";
    } else if (dtuStatus === "Starting") {
      dtuStatusEl.innerText = "DTU: Starting...";
      dtuStatusEl.className = "status-badge status-Running";
    } else if (dtuStatus === "Failed" || dtuStatus === "Error") {
      dtuStatusEl.innerText = "DTU: Error (Click to Retry)";
      dtuStatusEl.className = "status-badge status-Failed";
    } else {
      dtuStatusEl.innerText = "DTU: Stopped (Click to Start)";
      dtuStatusEl.className = "status-badge status-Failed";
    }
  };

  if (dtuStatusEl) {
    dtuStatusEl.addEventListener("click", async () => {
      if (
        dtuStatusEl.innerText.includes("Starting") ||
        dtuStatusEl.innerText.includes("Stopping")
      ) {
        return;
      }
      const isCurrentlyRunning = dtuStatusEl.innerText.includes("Running");
      dtuStatusEl.innerText = isCurrentlyRunning ? "DTU: Stopping..." : "DTU: Starting...";
      dtuStatusEl.className = "status-badge status-Running";
      try {
        await fetch("http://localhost:8912/dtu", {
          method: isCurrentlyRunning ? "DELETE" : "POST",
        });
      } catch {}
      await pollDtuStatus();
    });
    pollDtuStatus();
  }

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
        if (data.type === "dtuStatusChanged") {
          pollDtuStatus();
        }
        if (data.type === "runFinished") {
          isStreamingLogs = false;
          loadLogs();
        }
        if (data.type === "runStarted") {
          loadLogs();
        }
        // Live log streaming via SSE
        if (data.type === "runLog" && data.runId === activeRunId && logsViewer) {
          isStreamingLogs = true;
          const isAtBottom =
            logsViewer.scrollHeight - logsViewer.scrollTop - logsViewer.clientHeight < 10;
          const line = document.createElement("div");
          line.innerHTML = ansiUp.ansi_to_html(data.line);
          logsViewer.appendChild(line);
          if (isAtBottom) {
            logsViewer.scrollTop = logsViewer.scrollHeight;
          }
        }
      } catch {}
    });
  } catch {}
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
