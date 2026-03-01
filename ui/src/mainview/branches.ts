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

async function goToCommits(branchName: string) {
  await setAppState({ branchName });
  window.location.href = "views://commits/index.html";
}

async function loadBranches() {
  const branchesList = document.getElementById("branches-list");
  if (!branchesList || !repoPath) {
    return;
  }

  const branches = await fetch(
    "http://localhost:8912/git/branches?repoPath=" + encodeURIComponent(repoPath),
  ).then((r) => r.json());
  branchesList.innerHTML = "";
  branches.forEach((b: any, idx: number) => {
    const item = document.createElement("div");
    item.className = "list-item animate-fade-in";
    item.style.animationDelay = `${idx * 0.05}s`;
    if (b.isCurrent) {
      item.style.borderColor = "var(--accent)";
    }

    const label = b.isCurrent ? `${b.name} (Current)` : b.isRemote ? `${b.name}` : b.name;
    const remoteTag = b.isRemote
      ? `<span style="font-size: 11px; color: var(--text-secondary); background: var(--panel-bg); padding: 2px 6px; border-radius: 4px; margin-left: 8px;">remote</span>`
      : "";

    item.innerHTML = `
      <div>
        <div class="list-item-title" style="${b.isCurrent ? "font-weight: bold; color: var(--accent);" : b.isRemote ? "color: var(--text-secondary);" : ""}">
          ${label}${remoteTag}
        </div>
      </div>
    `;
    item.addEventListener("click", () => goToCommits(b.name));
    branchesList.appendChild(item);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();
  const state = await getAppStateAsync();
  repoPath = state.repoPath;

  // Auto-enable watching so we get SSE events for branch switches and new commits
  if (repoPath) {
    fetch("http://localhost:8912/repos/watched", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoPath }),
    }).catch(() => {});
  }

  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  const projName = document.getElementById("repo-name-display");
  if (projName && repoPath) {
    projName.innerText = repoPath.split("/").pop() || repoPath;
  }

  await loadBranches();

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
          if (data.type === "branchChanged" || data.type === "commitDetected") {
            loadBranches();
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
