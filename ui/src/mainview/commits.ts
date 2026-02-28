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
let branchName = "";

let selectedCommitId: string | null = null;
let lastRunsJson: string | null = null;

async function selectCommit(commitId: string, label: string) {
  selectedCommitId = commitId;
  lastRunsJson = null;
  await setAppState({ commitId });

  const header = document.getElementById("selected-commit-header");
  if (header) {
    header.innerText = label;
  }

  const container = document.getElementById("commit-details-container");
  if (container) {
    container.style.display = "block";
  }

  await loadWorkflows();
  await loadRuns();
}

async function loadWorkflows() {
  const workflowsList = document.getElementById("workflows-list");
  if (!workflowsList || !repoPath) {
    return;
  }

  const workflows = await fetch(
    "http://localhost:8912/workflows?repoPath=" + encodeURIComponent(repoPath),
  ).then((r) => r.json());
  workflowsList.innerHTML = "";

  if (workflows.length === 0) {
    workflowsList.innerHTML = `<div style="color: var(--text-secondary); font-style: italic">No workflows found.</div>`;
    return;
  }

  workflows.forEach((wf: any, idx: number) => {
    const item = document.createElement("div");
    item.className = "list-item animate-fade-in";
    item.style.animationDelay = `${idx * 0.05}s`;
    item.style.cursor = "default";

    item.innerHTML = `
      <div>
        <div class="list-item-title">${wf.name}</div>
        <div class="list-item-subtitle">${wf.id}</div>
      </div>
      <button class="btn btn-primary run-wf-btn" data-id="${wf.id}" style="height: 28px; padding: 0 12px; font-size: 12px">Run</button>
    `;

    const btn = item.querySelector(".run-wf-btn");
    if (btn) {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.setAttribute("disabled", "true");
        btn.innerHTML = "Starting...";
        try {
          await fetch("http://localhost:8912/workflows/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath, workflowId: wf.id, commitId: selectedCommitId }),
          }).then((r) => r.json());
          await loadRuns();
        } finally {
          btn.removeAttribute("disabled");
          btn.innerHTML = "Run";
        }
      });
    }

    workflowsList.appendChild(item);
  });
}

function getStatusBadge(status: string) {
  let cls = "status-Unknown";
  if (status === "Passed") {
    cls = "status-Passed";
  } else if (status === "Failed") {
    cls = "status-Failed";
  } else if (status === "Running") {
    cls = "status-Running";
  }
  return `<span class="status-badge ${cls}">${status}</span>`;
}

async function loadRuns() {
  if (!selectedCommitId || !repoPath) {
    return;
  }
  const runsList = document.getElementById("runs-list");
  if (!runsList) {
    return;
  }

  const history = await fetch(
    "http://localhost:8912/workflows/commits?repoPath=" +
      encodeURIComponent(repoPath) +
      "&commitId=" +
      encodeURIComponent(selectedCommitId),
  ).then((r) => r.json());

  // Skip DOM rebuild if data hasn't changed
  const newJson = JSON.stringify(history);
  if (newJson === lastRunsJson) {
    return;
  }
  lastRunsJson = newJson;

  runsList.innerHTML = "";

  if (history.length === 0) {
    runsList.innerHTML = `<div style="color: var(--text-secondary); font-style: italic">No runs for this commit.</div>`;
    return;
  }

  history.forEach((run: any, idx: number) => {
    const item = document.createElement("div");
    item.className = "list-item animate-fade-in";
    item.style.animationDelay = `${idx * 0.05}s`;
    item.style.cursor = "pointer";

    item.innerHTML = `
      <div>
        <div class="list-item-title">${run.workflowName}</div>
        <div class="list-item-subtitle">${new Date(run.date).toLocaleString()}</div>
      </div>
      <div>
        ${getStatusBadge(run.status)}
      </div>
    `;
    item.addEventListener("click", async () => {
      await setAppState({ runId: run.runId });
      window.location.href = "views://runs/index.html";
    });
    runsList.appendChild(item);
  });
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

  const commits = await fetch(
    "http://localhost:8912/git/commits?repoPath=" +
      encodeURIComponent(repoPath) +
      "&branch=" +
      encodeURIComponent(branchName),
  ).then((r) => r.json());
  list.innerHTML = "";

  const branches = await fetch(
    "http://localhost:8912/git/branches?repoPath=" + encodeURIComponent(repoPath),
  ).then((r) => r.json());
  const isCurrentBranch =
    branches.find((b: { name: string; isCurrent: boolean }) => b.name === branchName)?.isCurrent ??
    false;

  if (isCurrentBranch) {
    const hasChanges = await fetch(
      "http://localhost:8912/git/working-tree?repoPath=" + encodeURIComponent(repoPath),
    )
      .then((r) => r.json())
      .then((r) => r.dirty);
    const wtItem = document.createElement("div");
    wtItem.className = "list-item animate-fade-in";
    wtItem.style.borderColor = hasChanges ? "var(--accent)" : "var(--panel-border)";
    wtItem.innerHTML = `
      <div>
        <div class="list-item-title">Current Working Tree</div>
        <div class="list-item-subtitle">${hasChanges ? "Has uncommitted changes" : "Clean"}</div>
      </div>
    `;
    wtItem.addEventListener("click", () => selectCommit("WORKING_TREE", "Current Working Tree"));
    list.appendChild(wtItem);
  }

  if (commits.length > 0) {
    commits.forEach((commit: any, idx: number) => {
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

      item.addEventListener("click", () => selectCommit(commit.id, commit.label));
      list.appendChild(item);
    });
  } else {
    list.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">No commits found.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();
  const state = await getAppStateAsync();
  repoPath = state.repoPath;
  branchName = state.branchName;

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

    const isWatchEnabled = await fetch("http://localhost:8912/repos/watched")
      .then((r) => r.json())
      .then((r) => r.includes(repoPath));
    updateWatchUI(isWatchEnabled);

    runOnCommitToggle.addEventListener("click", async () => {
      runOnCommitToggle.setAttribute("disabled", "true");
      try {
        const currentState = await fetch("http://localhost:8912/repos/watched")
          .then((r) => r.json())
          .then((r) => r.includes(repoPath));
        const newState = !currentState;
        await fetch("http://localhost:8912/repos/watched", {
          method: newState ? "POST" : "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repoPath }),
        });
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
            loadCommits();
          }
          if (data.type === "runStarted" || data.type === "runFinished") {
            loadRuns();
          }
        } catch {}
      });
    } catch {}
  }
});

// Global escape listener
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
