import { getAppStateAsync, setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
import { api } from "./api.ts";

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
  const state = await getAppStateAsync(rpc);
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
    const workflows = await api("/workflows?repoPath=" + encodeURIComponent(repoPath));
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

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
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
