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

  const [workflows, enabledMap]: [
    { id: string; name: string; triggers: string[]; enabledByDefault: boolean }[],
    Record<string, boolean>,
  ] = await Promise.all([
    fetch("http://localhost:8912/workflows?repoPath=" + encodeURIComponent(repoPath)).then((r) =>
      r.json(),
    ),
    fetch("http://localhost:8912/workflows/enabled?repoPath=" + encodeURIComponent(repoPath)).then(
      (r) => r.json(),
    ),
  ]);

  workflowsList.innerHTML = "";

  if (workflows.length === 0) {
    workflowsList.innerHTML = `<div style="color: var(--text-secondary); font-style: italic">No workflows found.</div>`;
    return;
  }

  workflows.forEach((wf, idx: number) => {
    const isEnabled = enabledMap[wf.id] ?? wf.enabledByDefault;
    const runsOnText =
      wf.triggers && wf.triggers.length > 0 ? wf.triggers.join(", ") : "manual only";

    const item = document.createElement("div");
    item.className = "list-item animate-fade-in";
    item.style.animationDelay = `${idx * 0.05}s`;
    item.style.cursor = "default";

    item.innerHTML = `
      <div style="flex: 1; min-width: 0">
        <div class="list-item-title">${wf.name}</div>
        <div class="list-item-subtitle">${wf.id}</div>
        <div style="font-size: 11px; color: var(--text-secondary); margin-top: 2px">
          runs on: <span style="color: var(--text-primary)">${runsOnText}</span>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0">
        <button class="auto-toggle-btn" data-id="${wf.id}" data-enabled="${isEnabled}" style="
          height: 24px;
          padding: 0 10px;
          font-size: 11px;
          font-weight: 600;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
          background: ${isEnabled ? "#28a745" : "#444"};
          color: ${isEnabled ? "#fff" : "#aaa"};
        ">Auto ${isEnabled ? "On" : "Off"}</button>
        <button class="btn btn-primary run-wf-btn" data-id="${wf.id}" style="height: 28px; padding: 0 12px; font-size: 12px">Run</button>
      </div>
    `;

    const autoBtn = item.querySelector(".auto-toggle-btn") as HTMLButtonElement;
    if (autoBtn) {
      autoBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const currentEnabled = autoBtn.dataset["enabled"] === "true";
        const newEnabled = !currentEnabled;
        autoBtn.setAttribute("disabled", "true");
        try {
          await fetch("http://localhost:8912/workflows/enabled", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath, workflowId: wf.id, enabled: newEnabled }),
          });
          autoBtn.dataset["enabled"] = String(newEnabled);
          autoBtn.textContent = `Auto ${newEnabled ? "On" : "Off"}`;
          autoBtn.style.background = newEnabled ? "#28a745" : "#444";
          autoBtn.style.color = newEnabled ? "#fff" : "#aaa";
        } finally {
          autoBtn.removeAttribute("disabled");
        }
      });
    }

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

function formatElapsed(startMs: number, endMs?: number): string {
  const elapsed = Math.max(0, ((endMs ?? Date.now()) - startMs) / 1000);
  if (elapsed < 60) {
    return `${Math.round(elapsed)}s`;
  }
  const mins = Math.floor(elapsed / 60);
  const secs = Math.round(elapsed % 60);
  return `${mins}m ${secs}s`;
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

  const history: {
    runId: string;
    runnerName: string;
    workflowName: string;
    jobName: string | null;
    workflowRunId: string;
    status: string;
    date: number;
    endDate?: number;
  }[] = await fetch(
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

  // Group by workflowRunId — preserving order of first appearance (history is newest-first)
  const groupOrder: string[] = [];
  const groups = new Map<string, typeof history>();
  for (const run of history) {
    const gid = run.workflowRunId;
    if (!groups.has(gid)) {
      groups.set(gid, []);
      groupOrder.push(gid);
    }
    groups.get(gid)!.push(run);
  }

  groupOrder.forEach((workflowRunId, idx) => {
    const jobs = groups.get(workflowRunId)!;
    const isMultiJob = jobs.some((j) => j.jobName !== null);

    // Derive overall status for the group
    let overallStatus = jobs[0].status;
    if (jobs.some((j) => j.status === "Failed")) {
      overallStatus = "Failed";
    } else if (jobs.some((j) => j.status === "Running")) {
      overallStatus = "Running";
    } else if (jobs.every((j) => j.status === "Passed")) {
      overallStatus = "Passed";
    }

    const firstJob = jobs[0];
    const elapsed = formatElapsed(firstJob.date, firstJob.endDate);

    if (!isMultiJob) {
      // Single-job run — render exactly as before
      const item = document.createElement("div");
      item.className = "list-item animate-fade-in";
      item.style.animationDelay = `${idx * 0.05}s`;
      item.style.cursor = "pointer";
      item.innerHTML = `
        <div>
          <div class="list-item-title">${firstJob.workflowName}</div>
          <div class="list-item-subtitle">${firstJob.runnerName} · ${new Date(firstJob.date).toLocaleString()} · ${elapsed}</div>
        </div>
        <div>${getStatusBadge(overallStatus)}</div>
      `;
      item.addEventListener("click", async () => {
        await setAppState({ runId: firstJob.runId });
        window.location.href = "views://runs/index.html";
      });
      runsList.appendChild(item);
      return;
    }

    // Multi-job run — header row (not clickable directly) + indented job rows
    const group = document.createElement("div");
    group.className = "animate-fade-in";
    group.style.animationDelay = `${idx * 0.05}s`;
    group.style.marginBottom = "4px";

    const header = document.createElement("div");
    header.className = "list-item";
    header.style.cursor = "default";
    header.style.borderBottomLeftRadius = "0";
    header.style.borderBottomRightRadius = "0";
    header.innerHTML = `
      <div>
        <div class="list-item-title">${firstJob.workflowName}</div>
        <div class="list-item-subtitle">${workflowRunId} · ${new Date(firstJob.date).toLocaleString()} · ${elapsed}</div>
      </div>
      <div>${getStatusBadge(overallStatus)}</div>
    `;
    group.appendChild(header);

    // Job rows
    jobs.forEach((job, ji) => {
      const isLast = ji === jobs.length - 1;
      const jobRow = document.createElement("div");
      jobRow.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px 6px 28px;
        cursor: pointer;
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-top: none;
        border-bottom-left-radius: ${isLast ? "6px" : "0"};
        border-bottom-right-radius: ${isLast ? "6px" : "0"};
        transition: background 0.15s;
      `;
      jobRow.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <span style="color:var(--text-secondary);font-size:11px">└</span>
          <span style="font-size:13px;color:var(--text-primary)">${job.jobName}</span>
        </div>
        <div>${getStatusBadge(job.status)}</div>
      `;
      jobRow.addEventListener("mouseenter", () => {
        jobRow.style.background = "var(--item-hover, rgba(255,255,255,0.05))";
      });
      jobRow.addEventListener("mouseleave", () => {
        jobRow.style.background = "var(--panel-bg)";
      });
      jobRow.addEventListener("click", async () => {
        await setAppState({ runId: job.runId });
        window.location.href = "views://runs/index.html";
      });
      group.appendChild(jobRow);
    });

    runsList.appendChild(group);
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

  // If a commit was previously selected (e.g. navigating back from a run),
  // restore its selection and refresh the runs list so stale statuses are updated.
  if (state.commitId) {
    selectedCommitId = state.commitId;
    const container = document.getElementById("commit-details-container");
    if (container) {
      container.style.display = "block";
    }
    const header = document.getElementById("selected-commit-header");
    if (header) {
      header.innerText =
        state.commitId === "WORKING_TREE"
          ? "Current Working Tree"
          : `Commit ${state.commitId.substring(0, 7)}`;
    }
    loadRuns();
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
