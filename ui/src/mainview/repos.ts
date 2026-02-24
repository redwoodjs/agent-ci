import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

async function goToCommits(repoPath: string) {
  await rpc.request.setAppState({ repoPath });
  window.location.href = "views://commits/index.html";
}

document.addEventListener("DOMContentLoaded", async () => {
  const recentList = document.getElementById("recent-repos-list");
  if (recentList) {
    const recent = await rpc.request.getRecentRepos();
    if (recent.length > 0) {
      recent.forEach((repoPath, idx) => {
        const item = document.createElement("div");
        item.className = "list-item animate-fade-in";
        item.style.animationDelay = `${idx * 0.05}s`;

        const text = document.createElement("div");
        text.className = "list-item-title";
        text.innerText = repoPath;
        item.appendChild(text);

        item.addEventListener("click", () => goToCommits(repoPath));
        recentList.appendChild(item);
      });
    } else {
      recentList.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">No recent repos. Click "Open Repo..." to get started.</div>`;
    }
  }

  const selectBtn = document.getElementById("select-repo-btn");
  if (selectBtn) {
    selectBtn.addEventListener("click", async () => {
      selectBtn.setAttribute("disabled", "true");
      try {
        const selectedPath = await rpc.request.selectRepo();
        if (selectedPath) {
          goToCommits(selectedPath);
        }
      } catch (e) {
        console.error(e);
      } finally {
        selectBtn.removeAttribute("disabled");
      }
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
