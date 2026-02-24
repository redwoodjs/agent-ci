import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let repoPath = "";
let branchName = "";

async function goToWorkflows(commitId: string) {
  await rpc.request.setAppState({ commitId });
  window.location.href = "views://workflows/index.html";
}

async function loadCommits() {
  const header = document.getElementById("current-branch-header");
  if (header) {
    header.innerText = `Commits: ${branchName}`;
  }

  const list = document.getElementById("commits-list");
  if (!list || !repoPath || !branchName) {
    return;
  }

  list.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">Loading...</div>`;

  const commits = await rpc.request.getGitCommits({ repoPath, branch: branchName });
  list.innerHTML = "";

  const branches = await rpc.request.getBranches({ repoPath });
  const isCurrentBranch = branches.find((b) => b.name === branchName)?.isCurrent ?? false;

  if (isCurrentBranch) {
    const hasChanges = await rpc.request.getWorkingTreeStatus({ repoPath });
    const wtItem = document.createElement("div");
    wtItem.className = "list-item animate-fade-in";
    wtItem.style.borderColor = hasChanges ? "var(--accent)" : "var(--panel-border)";
    wtItem.innerHTML = `
      <div>
        <div class="list-item-title">Current Working Tree</div>
        <div class="list-item-subtitle">${hasChanges ? "Has uncommitted changes" : "Clean"}</div>
      </div>
    `;
    wtItem.addEventListener("click", () => goToWorkflows("WORKING_TREE"));
    list.appendChild(wtItem);
  }

  if (commits.length > 0) {
    commits.forEach((commit, idx) => {
      const item = document.createElement("div");
      item.className = "list-item animate-fade-in";
      item.style.animationDelay = `${idx * 0.02}s`;

      const textWrapper = document.createElement("div");
      const title = document.createElement("div");
      title.className = "list-item-title";
      title.innerText = commit.label;
      const sub = document.createElement("div");
      sub.className = "list-item-subtitle";
      sub.innerText = `${commit.id.substring(0, 7)} · ${new Date(commit.date).toLocaleString()} by ${commit.author}`;

      textWrapper.appendChild(title);
      textWrapper.appendChild(sub);
      item.appendChild(textWrapper);

      item.addEventListener("click", () => goToWorkflows(commit.id));
      list.appendChild(item);
    });
  } else {
    list.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">No commits found.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const state = await rpc.request.getAppState();
  repoPath = state.repoPath;
  branchName = state.branchName;

  const backBtn = document.getElementById("back-btn");
  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  const projName = document.getElementById("repo-name-display");
  if (projName && repoPath) {
    projName.innerText = repoPath.split("/").pop() || repoPath;
  }

  const runOnCommitToggle = document.getElementById("watch-mode-toggle");
  if (runOnCommitToggle && repoPath) {
    const updateWatchUI = (enabled: boolean) => {
      if (enabled) {
        runOnCommitToggle.innerText = "On";
        runOnCommitToggle.style.background = "#28a745";
      } else {
        runOnCommitToggle.innerText = "Off";
        runOnCommitToggle.style.background = "#333";
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

  loadCommits();

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
