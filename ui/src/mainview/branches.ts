import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";

async function goToCommits(branchName: string) {
  await rpc.request.setAppState({ branchName });
  window.location.href = "views://commits/index.html";
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = await rpc.request.getAppState();
  repoPath = state.repoPath;

  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  const projName = document.getElementById("repo-name-display");
  if (projName && repoPath) {
    projName.innerText = repoPath.split("/").pop() || repoPath;
  }

  const branchesList = document.getElementById("branches-list");
  if (branchesList && repoPath) {
    const branches = await rpc.request.getBranches({ repoPath });
    branchesList.innerHTML = "";
    branches.forEach((b, idx) => {
      const item = document.createElement("div");
      item.className = "list-item animate-fade-in";
      item.style.animationDelay = `${idx * 0.05}s`;
      if (b.isCurrent) {
        item.style.borderColor = "var(--accent)";
      }

      item.innerHTML = `
        <div>
          <div class="list-item-title" style="${b.isCurrent ? "font-weight: bold; color: var(--accent);" : ""}">
            ${b.name} ${b.isCurrent ? "(Current)" : ""}
          </div>
        </div>
      `;
      item.addEventListener("click", () => goToCommits(b.name));
      branchesList.appendChild(item);
    });
  }

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

// Global escape listener
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
