import { getAppStateAsync, setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";
let commitId = "";

async function goToRuns(workflowId: string) {
  await setAppState({ workflowId });
  window.location.href = "views://runs/index.html";
}

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();
  const state = await getAppStateAsync();
  repoPath = state.repoPath;
  commitId = state.commitId;

  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  const commitLabel = document.getElementById("commit-label");
  if (commitLabel) {
    commitLabel.innerText =
      commitId === "WORKING_TREE" ? "Working Tree" : `Commit ${commitId.substring(0, 7)}`;
  }

  const workflowsList = document.getElementById("workflows-list");
  if (workflowsList && repoPath) {
    const workflows = await fetch(
      "http://localhost:8912/workflows?repoPath=" + encodeURIComponent(repoPath),
    ).then((r) => r.json());
    workflowsList.innerHTML = "";
    workflows.forEach((wf: any, idx: number) => {
      const item = document.createElement("div");
      item.className = "list-item animate-fade-in";
      item.style.animationDelay = `${idx * 0.05}s`;

      item.innerHTML = `
        <div>
          <div class="list-item-title">${wf.name}</div>
          <div class="list-item-subtitle">${wf.id}</div>
        </div>
      `;
      item.addEventListener("click", () => goToRuns(wf.id));
      workflowsList.appendChild(item);
    });
  }

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
    try {
      const evtSource = new EventSource("http://localhost:8912/events");
      evtSource.addEventListener("message", (event) => {
        try {
          const data = JSON.parse(event.data);
          recordSseEvent(data);
          if (data.type === "dtuStatusChanged") {
            pollDtuStatus();
          }
        } catch {}
      });
    } catch {}
  }
});

// Global back navigation (Escape key + mouse back button)
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
window.addEventListener("pointerdown", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    window.history.back();
  }
});
