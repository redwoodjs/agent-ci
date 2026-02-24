import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";

async function goToWorkflows(commitId: string) {
  await rpc.request.setAppState({ commitId });
  window.location.href = "views://workflows/index.html";
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
    projName.innerText = repoPath;
  }

  const runOnCommitToggle = document.getElementById("watch-mode-toggle");
  if (runOnCommitToggle && repoPath) {
    const updateWatchUI = (enabled: boolean) => {
      if (enabled) {
        runOnCommitToggle.innerText = "On";
        runOnCommitToggle.style.background = "#28a745";
        runOnCommitToggle.style.color = "white";
      } else {
        runOnCommitToggle.innerText = "Off";
        runOnCommitToggle.style.background = "#333";
        runOnCommitToggle.style.color = "white";
      }
    };

    const isWatchEnabled = await rpc.request.getRunOnCommitEnabled({ repoPath });
    updateWatchUI(isWatchEnabled);

    runOnCommitToggle.addEventListener("click", async () => {
      runOnCommitToggle.setAttribute("disabled", "true");
      try {
        const currentState = await rpc.request.getRunOnCommitEnabled({ repoPath });
        const newState = !currentState;
        await rpc.request.toggleRunOnCommit({ repoPath, enabled: newState });
        updateWatchUI(newState);
      } catch (e) {
        console.error("Failed to toggle run on commit", e);
      } finally {
        runOnCommitToggle.removeAttribute("disabled");
      }
    });
  }

  const list = document.getElementById("commits-list");
  if (list && repoPath) {
    const commits = await rpc.request.getRunCommits({ repoPath });
    if (commits.length > 0) {
      commits.forEach((commit, idx) => {
        const item = document.createElement("div");
        item.className = "list-item animate-fade-in";
        item.style.animationDelay = `${idx * 0.05}s`;

        const textWrapper = document.createElement("div");

        const title = document.createElement("div");
        title.className = "list-item-title";
        title.innerText = commit.label;

        const sub = document.createElement("div");
        sub.className = "list-item-subtitle";
        sub.innerText = new Date(commit.date).toLocaleString();

        textWrapper.appendChild(title);
        textWrapper.appendChild(sub);
        item.appendChild(textWrapper);

        item.addEventListener("click", () => goToWorkflows(commit.id));
        list.appendChild(item);
      });
    } else {
      list.innerHTML = `
        <div style="color: var(--text-secondary); text-align: center; padding: 32px">
          <div>No runs detected.</div>
          <button id="start-new-workflow-btn" class="btn btn-primary" style="margin-top: 16px;">Start a Workflow</button>
        </div>
      `;
      const startBtn = document.getElementById("start-new-workflow-btn");
      if (startBtn) {
        startBtn.addEventListener("click", () => goToWorkflows("WORKING_TREE"));
      }
    }
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
