import { getAppStateAsync, setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
import { api, apiPost, apiPut, apiDelete } from "./api.ts";
import { initGlobalErrorHandler } from "./global-error-handler.ts";

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
    api("/workflows?repoPath=" + encodeURIComponent(repoPath)),
    api("/workflows/enabled?repoPath=" + encodeURIComponent(repoPath)),
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
          await apiPut("/workflows/enabled", { repoPath, workflowId: wf.id, enabled: newEnabled });
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
          await apiPost("/workflows/run", {
            repoPath,
            workflowId: wf.id,
            commitId: selectedCommitId,
          });
          await loadRuns();
        } catch {
          // error already logged by api wrapper
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

  let history: {
    runId: string;
    runnerName: string;
    workflowName: string;
    jobName: string | null;
    workflowRunId: string;
    status: string;
    date: number;
    endDate?: number;
    attempt: number;
  }[];
  try {
    history = await api(
      "/workflows/commits?repoPath=" +
        encodeURIComponent(repoPath) +
        "&commitId=" +
        encodeURIComponent(selectedCommitId),
    );
  } catch {
    return;
  }

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

  // Helper: create a retry button for a failed run
  const makeRetryBtn = (runId: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.className = "btn retry-btn";
    btn.style.cssText = `
      height: 22px; padding: 0 8px; font-size: 11px;
      border: 1px solid var(--panel-border); border-radius: 4px;
      background: transparent; color: var(--text-secondary);
      cursor: pointer; transition: all 0.15s;
    `;
    btn.innerText = "↻ Retry";
    btn.addEventListener("mouseenter", () => {
      btn.style.borderColor = "var(--accent, #60a5fa)";
      btn.style.color = "var(--accent, #60a5fa)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.borderColor = "var(--panel-border)";
      btn.style.color = "var(--text-secondary)";
    });
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      btn.style.display = "none"; // Hide immediately
      try {
        await apiPost("/workflows/retry", { runId });
        lastRunsJson = null; // force refresh
        await loadRuns();
      } catch (err) {
        console.error("Retry failed:", err);
        btn.style.display = ""; // Show again on error
      }
    });
    return btn;
  };

  groupOrder.forEach((workflowRunId, idx) => {
    const jobs = groups.get(workflowRunId)!;
    const isMultiJob = jobs.some((j) => j.jobName !== null);

    // Check if any job has multiple attempts
    const hasMultipleAttempts = jobs.some((j) => (j.attempt ?? 1) > 1);

    // Derive overall status for the group (use latest attempt per job)
    // First, get the latest attempt of each unique job
    const latestByJob = new Map<string | null, (typeof history)[0]>();
    for (const job of jobs) {
      const key = job.jobName;
      const existing = latestByJob.get(key);
      if (!existing || (job.attempt ?? 1) > (existing.attempt ?? 1)) {
        latestByJob.set(key, job);
      }
    }
    const latestJobs = Array.from(latestByJob.values());

    let overallStatus = latestJobs[0].status;
    if (latestJobs.some((j) => j.status === "Failed")) {
      overallStatus = "Failed";
    } else if (latestJobs.some((j) => j.status === "Running")) {
      overallStatus = "Running";
    } else if (latestJobs.every((j) => j.status === "Passed")) {
      overallStatus = "Passed";
    }

    const firstJob = jobs.reduce((a, b) => (a.date < b.date ? a : b));
    const latestJob = latestJobs.reduce((a, b) =>
      (a.endDate ?? a.date) > (b.endDate ?? b.date) ? a : b,
    );
    const elapsed = formatElapsed(firstJob.date, latestJob.endDate);

    if (!isMultiJob) {
      // Single-job run — may have multiple attempts
      const sortedAttempts = [...jobs].sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
      const latest = sortedAttempts[sortedAttempts.length - 1];

      if (!hasMultipleAttempts) {
        // Simple case: single attempt, single row
        const item = document.createElement("div");
        item.className = "list-item animate-fade-in";
        item.style.animationDelay = `${idx * 0.05}s`;
        item.style.cursor = "pointer";
        item.innerHTML = `
          <div style="flex:1;min-width:0">
            <div class="list-item-title">${latest.workflowName}</div>
            <div class="list-item-subtitle">${latest.runnerName} · ${new Date(latest.date).toLocaleString()} · ${elapsed}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            ${getStatusBadge(latest.status)}
          </div>
        `;
        item.addEventListener("click", async () => {
          await setAppState({ runId: latest.runId });
          window.location.href = "views://runs/index.html";
        });
        if (latest.status === "Failed") {
          const actions = item.querySelector("div:last-child");
          if (actions) {
            actions.prepend(makeRetryBtn(latest.runId));
          }
        }
        runsList.appendChild(item);
        return;
      }

      // Multiple attempts: header (original) + nested retries
      const singleGroup = document.createElement("div");
      singleGroup.className = "animate-fade-in";
      singleGroup.style.animationDelay = `${idx * 0.05}s`;
      singleGroup.style.marginBottom = "4px";

      // Header row — show overall status based on latest attempt
      const headerRow = document.createElement("div");
      headerRow.className = "list-item";
      headerRow.style.cursor = "pointer";
      headerRow.style.borderBottomLeftRadius = "0";
      headerRow.style.borderBottomRightRadius = "0";
      headerRow.innerHTML = `
        <div style="flex:1;min-width:0">
          <div class="list-item-title">${latest.workflowName}</div>
          <div class="list-item-subtitle">${workflowRunId} · ${new Date(firstJob.date).toLocaleString()} · ${elapsed}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${getStatusBadge(latest.status)}
        </div>
      `;
      headerRow.addEventListener("click", async () => {
        await setAppState({ runId: latest.runId });
        window.location.href = "views://runs/index.html";
      });
      if (latest.status === "Failed") {
        const actions = headerRow.querySelector("div:last-child");
        if (actions) {
          actions.prepend(makeRetryBtn(latest.runId));
        }
      }
      singleGroup.appendChild(headerRow);

      // Sub-rows for each attempt (newest first)
      const reversedAttempts = [...sortedAttempts].reverse();
      reversedAttempts.forEach((attempt, ai) => {
        const isLast = ai === reversedAttempts.length - 1;
        const row = document.createElement("div");
        const isLatestAttempt = attempt === latest;
        row.style.cssText = `
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
          opacity: ${isLatestAttempt ? "1" : "0.6"};
        `;
        row.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:var(--text-secondary);font-size:11px">└</span>
            <span style="font-size:11px;color:var(--text-secondary)">${attempt.runnerName}</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="attempt-badge">Attempt ${attempt.attempt ?? 1}</span>
            ${getStatusBadge(attempt.status)}
          </div>
        `;
        row.addEventListener("mouseenter", () => {
          row.style.background = "var(--item-hover, rgba(255,255,255,0.05))";
        });
        row.addEventListener("mouseleave", () => {
          row.style.background = "var(--panel-bg)";
        });
        row.addEventListener("click", async () => {
          await setAppState({ runId: attempt.runId });
          window.location.href = "views://runs/index.html";
        });
        singleGroup.appendChild(row);
      });

      runsList.appendChild(singleGroup);
      return;
    }

    // Multi-job run — header row + indented job rows with nested retries
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

    // Group jobs by jobName, then sort attempts within each group
    const jobsByName = new Map<string | null, typeof history>();
    for (const job of jobs) {
      const key = job.jobName;
      if (!jobsByName.has(key)) {
        jobsByName.set(key, []);
      }
      jobsByName.get(key)!.push(job);
    }
    // Sort each group by attempt
    for (const arr of jobsByName.values()) {
      arr.sort((a, b) => (a.attempt ?? 1) - (b.attempt ?? 1));
    }

    const jobNames = Array.from(jobsByName.keys());
    // Flatten: for each job, show latest attempt (top row) first, then older retries nested below
    type RowInfo = {
      job: (typeof history)[0];
      isOldRetry: boolean;
      isLatest: boolean;
      isLastInGroup: boolean;
    };
    const allRows: RowInfo[] = [];
    for (const name of jobNames) {
      const attempts = jobsByName.get(name)!;
      const latest = attempts[attempts.length - 1];
      const hasRetries = attempts.length > 1;
      // Top row: latest attempt
      allRows.push({
        job: latest,
        isOldRetry: false,
        isLatest: true,
        isLastInGroup: !hasRetries,
      });
      // Nested rows: older attempts (oldest→newest), underneath the top row
      if (hasRetries) {
        const olderAttempts = attempts.slice(0, -1).reverse();
        olderAttempts.forEach((a, i) => {
          allRows.push({
            job: a,
            isOldRetry: true,
            isLatest: false,
            isLastInGroup: i === olderAttempts.length - 1,
          });
        });
      }
    }

    allRows.forEach(({ job, isOldRetry, isLatest, isLastInGroup: _isLastInGroup }, ji) => {
      const isLast = ji === allRows.length - 1;
      const jobRow = document.createElement("div");
      const indent = isOldRetry ? "44px" : "28px";
      const fontSize = isOldRetry ? "12px" : "13px";
      const opacity = isOldRetry ? "0.6" : "1";
      jobRow.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px 6px ${indent};
        cursor: pointer;
        background: var(--panel-bg);
        border: 1px solid var(--panel-border);
        border-top: none;
        border-bottom-left-radius: ${isLast ? "6px" : "0"};
        border-bottom-right-radius: ${isLast ? "6px" : "0"};
        transition: background 0.15s;
        opacity: ${opacity};
      `;

      const prefix = isOldRetry
        ? `<span style="color:var(--text-secondary);font-size:11px">└</span>`
        : `<span style="color:var(--text-secondary);font-size:11px">└</span>`;
      const nameLabel = `<span style="font-size:${fontSize};color:var(--text-primary)">${job.jobName}</span>`;

      // Attempt badge goes on the right side, next to the status badge
      const attemptBadge = hasMultipleAttempts
        ? `<span class="attempt-badge">Attempt ${job.attempt ?? 1}</span>`
        : "";

      jobRow.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          ${prefix}
          ${nameLabel}
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          ${attemptBadge}
          ${getStatusBadge(job.status)}
        </div>
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
      // Add retry button on the top job row (latest attempt) if it failed
      if (job.status === "Failed" && isLatest) {
        const actions = jobRow.querySelector("div:last-child");
        if (actions) {
          actions.prepend(makeRetryBtn(job.runId));
        }
      }
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

  initGlobalErrorHandler();

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

    const watchedRepos = await api<string[]>("/repos/watched");
    const isWatchEnabled = watchedRepos.includes(repoPath);
    updateWatchUI(isWatchEnabled);

    runOnCommitToggle.addEventListener("click", async () => {
      runOnCommitToggle.setAttribute("disabled", "true");
      try {
        const current = await api<string[]>("/repos/watched");
        const newState = !current.includes(repoPath);
        if (newState) {
          await apiPost("/repos/watched", { repoPath });
        } else {
          await apiDelete("/repos/watched", { repoPath });
        }
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
      const data = await api<{ status: string }>("/dtu");
      dtuStatus = data.status;
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
        await api("/dtu", { method: isCurrentlyRunning ? "DELETE" : "POST" });
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

// Refresh commits list when navigating back (bfcache restore won't fire DOMContentLoaded)
window.addEventListener("pageshow", (e) => {
  if (e.persisted) {
    loadCommits();
    if (selectedCommitId) {
      loadRuns();
    }
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
