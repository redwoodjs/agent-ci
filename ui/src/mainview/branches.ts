import { getAppStateAsync, setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
import { apiPost } from "./api.ts";

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

  // Git reads go directly through Electrobun RPC — no supervisor dependency
  const branches = await rpc.request.getBranches();
  branchesList.innerHTML = "";
  branches.forEach((b, idx) => {
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
  const state = await getAppStateAsync(rpc);
  repoPath = state.repoPath;

  // Auto-enable watching so we get SSE events for branch switches and new commits
  if (repoPath) {
    apiPost("/repos/watched", { repoPath }).catch(() => {});
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

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
        if (data.type === "branchChanged" || data.type === "commitDetected") {
          loadBranches();
        }
      } catch {}
    });
  } catch {}
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
