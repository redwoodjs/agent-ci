import { getAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { AnsiUp } from "ansi_up";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
import { apiPost } from "./api.ts";
import { initGlobalErrorHandler } from "./global-error-handler.ts";

const ansiUp = new AnsiUp();

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let activeRunId: string | null = null;
let resolvedRunnerName: string | null = null;
let runStartDate: number = 0;
let runEndDate: number | undefined;
let activeStepId: string | null = null;
let activeLogsPath: string | null = null;

function formatElapsed(startMs: number, endMs?: number): string {
  const elapsed = Math.max(0, ((endMs ?? Date.now()) - startMs) / 1000);
  if (elapsed < 60) {
    return `${Math.round(elapsed)}s`;
  }
  const mins = Math.floor(elapsed / 60);
  const secs = Math.round(elapsed % 60);
  return `${mins}m ${secs}s`;
}

/** Convert internal runner ID to a readable label (e.g. "Run #34" or "Run #34 · retry 2"). */
function formatRunnerName(name: string): string {
  const match = name.match(/(\d+)(?:-r(\d+))?$/);
  if (!match) {
    return name;
  }
  return match[2] ? `Run #${match[1]} · retry ${match[2]}` : `Run #${match[1]}`;
}
let statusPollTimer: ReturnType<typeof setInterval> | null = null;

// UI Elements
const backBtn = document.getElementById("back-btn");
const workflowLabel = document.getElementById("workflow-label");
const logsViewer = document.getElementById("logs-viewer");
const runTitle = document.getElementById("run-title");
const runStatus = document.getElementById("run-status");
const stopRunBtn = document.getElementById("stop-run-btn");
const retryRunBtn = document.getElementById("retry-run-btn");
const stepListEl = document.getElementById("step-list") as HTMLElement | null;
const errorSummaryEl = document.getElementById("error-summary") as HTMLElement | null;

interface TimelineRecord {
  id: string;
  name: string;
  type: string;
  order: number;
  state: string;
  result: string | null;
  startTime: string | null;
  finishTime: string | null;
  refName: string | null;
  parentId: string | null;
}

function formatElapsedMs(startTime: string | null, finishTime: string | null): string {
  if (!startTime) {
    return "";
  }
  const start = new Date(startTime).getTime();
  const end = finishTime ? new Date(finishTime).getTime() : Date.now();
  const secs = Math.round(Math.max(0, end - start) / 1000);
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function stepIcon(record: TimelineRecord): string {
  if (record.state === "pending") {
    return `<span class="step-icon step-icon-pending">○</span>`;
  }
  if (record.state !== "completed") {
    // In progress
    return `<span class="step-icon step-icon-running"><span class="step-spinner">⟳</span></span>`;
  }
  if (record.result === "succeeded") {
    return `<span class="step-icon step-icon-success">✓</span>`;
  }
  if (record.result === "failed") {
    return `<span class="step-icon step-icon-failure">✗</span>`;
  }
  if (record.result === "skipped") {
    return `<span class="step-icon step-icon-skipped">—</span>`;
  }
  return `<span class="step-icon step-icon-pending">·</span>`;
}

function scrollToStep(stepName: string) {
  if (!logsViewer) {
    return;
  }

  // Post steps, Complete job, Set up job have no ##[group] in logs — scroll to bottom
  if (stepName.startsWith("Post ") || stepName === "Complete job" || stepName === "Set up job") {
    logsViewer.scrollTop = logsViewer.scrollHeight;
    return;
  }

  // Build candidate names: exact name, and without "Run " prefix
  const candidates: string[] = [stepName];
  if (stepName.startsWith("Run ")) {
    candidates.push(stepName.slice(4));
  }

  // Find the step divider and read its starting line number
  const dividers = Array.from(logsViewer.querySelectorAll("[data-step-line]"));
  for (const candidate of candidates) {
    for (const el of dividers) {
      const dividerName = (el as HTMLElement).dataset["stepDivider"] || "";
      if (
        dividerName === candidate ||
        dividerName.includes(candidate) ||
        candidate.includes(dividerName)
      ) {
        const targetLine = (el as HTMLElement).dataset["stepLine"];
        if (targetLine) {
          const lineEl = logsViewer.querySelector(`[data-log-line="${targetLine}"]`);
          if (lineEl) {
            (lineEl as HTMLElement).scrollIntoView({ block: "start", behavior: "instant" });
            return;
          }
        }
      }
    }
  }

  // Fallback: text-match on log lines
  const children = Array.from(logsViewer.querySelectorAll("[data-log-line]"));
  for (const candidate of candidates) {
    for (const el of children) {
      const text = el.textContent || "";
      if (text.includes(candidate)) {
        (el as HTMLElement).scrollIntoView({ block: "start", behavior: "instant" });
        return;
      }
    }
  }

  // No matching logs found (e.g. Post steps, Complete job) — scroll to bottom
  logsViewer.scrollTop = logsViewer.scrollHeight;
}

function setActiveStep(stepId: string, stepName: string) {
  activeStepId = stepId;
  // Update active class
  if (stepListEl) {
    stepListEl.querySelectorAll(".step-row").forEach((row) => {
      if ((row as HTMLElement).dataset["stepId"] === stepId) {
        row.classList.add("active");
      } else {
        row.classList.remove("active");
      }
    });
  }
  scrollToStep(stepName);
}

function renderStepList(records: TimelineRecord[]) {
  if (!stepListEl) {
    return;
  }
  // Only show Task-type records, ordered
  const tasks = records
    .filter((r) => r.type === "Task")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (tasks.length === 0) {
    stepListEl.style.display = "none";
    return;
  }
  stepListEl.style.display = "block";

  // Preserve active selection across re-renders
  stepListEl.innerHTML = tasks
    .map((r) => {
      const elapsed = formatElapsedMs(r.startTime, r.finishTime);
      const isActive = r.id === activeStepId ? " active" : "";
      return `<div class="step-row${isActive}" data-step-id="${r.id}" data-step-name="${r.name.replace(/"/g, "&quot;")}">
        ${stepIcon(r)}
        <span class="step-name" title="${r.name}">${r.name}</span>
        ${elapsed ? `<span class="step-elapsed">${elapsed}</span>` : ""}
      </div>`;
    })
    .join("");

  // Attach click handlers
  stepListEl.querySelectorAll(".step-row").forEach((row) => {
    row.addEventListener("click", () => {
      const el = row as HTMLElement;
      const stepId = el.dataset["stepId"] || "";
      const stepName = el.dataset["stepName"] || "";
      setActiveStep(stepId, stepName);
    });
  });
}

async function loadTimeline() {
  if (!activeRunId) {
    return;
  }
  try {
    const records: TimelineRecord[] = await rpc.request.getRunTimeline({ runId: activeRunId });
    renderStepList(records);
  } catch {
    // timeline not available yet
  }
}

async function loadLogs() {
  if (!activeRunId) {
    return;
  }

  const details = await rpc.request.getRunDetail({ runId: activeRunId });
  if (!details) {
    if (logsViewer) {
      logsViewer.innerHTML = `<span style="color: var(--text-secondary)">Run not found: ${activeRunId}</span>`;
    }
    return;
  }
  const status = details.status || "Unknown";

  if (details.date && !runStartDate) {
    runStartDate = details.date;
  }
  if (details.endDate) {
    runEndDate = details.endDate;
  }
  if (details.runnerName) {
    resolvedRunnerName = details.runnerName;
  }
  if (details.logsPath) {
    activeLogsPath = details.logsPath;
  }

  if (runTitle) {
    const elapsed = runStartDate ? ` · ${formatElapsed(runStartDate, runEndDate)}` : "";
    const cacheLabel =
      details.warmCache === true
        ? ` <span class="warm-badge warm">🔥 warm cache</span>`
        : details.warmCache === false
          ? ` <span class="warm-badge cold">❄️ cold install</span>`
          : "";
    runTitle.innerHTML = `${formatRunnerName(details.runnerName || activeRunId || "")}${elapsed}${cacheLabel}`;
  }

  if (logsViewer && runStatus) {
    // Read log content directly from the filesystem via RPC
    {
      try {
        const logs = await rpc.request.getRunLogs({ runId: activeRunId });
        if (logs) {
          const isAtBottom =
            logsViewer.scrollHeight - logsViewer.scrollTop - logsViewer.clientHeight < 10;

          // Timestamp regex: ISO timestamps like "2026-03-01T16:20:38.2146072Z " or with BOM
          const tsRegex = /^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s*/;

          // Split raw text first, then process each line (preserves ANSI codes)
          const rawLines = logs.split("\n");
          const htmlParts: string[] = [];
          let lineNum = 1;
          let inStep = false;
          let groupDepth = 0;

          for (const rawLine of rawLines) {
            // Check for markers on the raw text (before ANSI conversion)
            // eslint-disable-next-line no-control-regex
            const stripped = rawLine.replace(/\x1b\[[0-9;]*m/g, "").replace(/\uFEFF/g, "");

            // Detect ##[group]
            const groupMatch = stripped.match(/##\[group\](.+)/);
            if (groupMatch) {
              const label = groupMatch[1].trim();

              if (!inStep) {
                // Top-level step group → sticky divider
                inStep = true;
                groupDepth = 0;
                htmlParts.push(
                  `<div class="log-step-divider" data-step-divider="${label.replace(/"/g, "&quot;")}" data-step-line="${lineNum}">▶ ${label}</div>`,
                );
              } else {
                // Inner group → collapsible section (starts collapsed)
                groupDepth++;
                htmlParts.push(
                  `<div class="log-group-header collapsed" data-group-toggle><span class="log-group-arrow">▶</span>${label}</div><div class="log-group-body collapsed">`,
                );
              }
              continue;
            }

            // Detect ##[endgroup]
            if (stripped.includes("##[endgroup]")) {
              if (groupDepth > 0) {
                htmlParts.push("</div>"); // close .log-group-body
                groupDepth--;
              }
              // When we hit an endgroup at depth 0, next group will be a new top-level step
              if (groupDepth === 0) {
                inStep = false;
              }
              continue;
            }

            // Detect ##[error] / ##[warning] / ##[notice] markers
            const annotationMatch = stripped.match(/##\[(error|warning|notice)\](.*)/);
            let extraClass = "";
            let copyBtn = "";

            // Strip timestamp from raw line, then convert ANSI to HTML
            let cleaned = rawLine.replace(tsRegex, "");

            if (annotationMatch) {
              const severity = annotationMatch[1];
              const errorMsg = annotationMatch[2].trim();
              if (severity === "error") {
                extraClass = " log-line-error";
              } else if (severity === "warning") {
                extraClass = " log-line-warning";
              }
              // Strip the ##[error]/##[warning] marker from displayed text
              cleaned = cleaned.replace(/##\[(error|warning|notice)\]/, "");
              // Add a copy button for error/warning lines
              if (severity === "error" || severity === "warning") {
                copyBtn = `<button class="log-line-copy" data-copy-text="${errorMsg.replace(/"/g, "&quot;")}">Copy</button>`;
              }
            }

            const content = ansiUp.ansi_to_html(cleaned) || "&nbsp;";

            htmlParts.push(
              `<div class="log-line${extraClass}" data-log-line="${lineNum}"><span class="log-line-number">${lineNum}</span><span class="log-line-content">${content}</span>${copyBtn}</div>`,
            );
            lineNum++;
          }

          // Close any unclosed groups
          while (groupDepth > 0) {
            htmlParts.push("</div>");
            groupDepth--;
          }

          logsViewer.innerHTML = htmlParts.join("");

          // Attach toggle handlers for collapsible groups
          logsViewer.querySelectorAll("[data-group-toggle]").forEach((header) => {
            header.addEventListener("click", () => {
              header.classList.toggle("collapsed");
              const body = header.nextElementSibling;
              if (body && body.classList.contains("log-group-body")) {
                body.classList.toggle("collapsed");
              }
            });
          });

          // Attach copy handlers for per-line copy buttons
          logsViewer.querySelectorAll(".log-line-copy").forEach((btn) => {
            btn.addEventListener("click", (e) => {
              e.stopPropagation();
              const text = (btn as HTMLElement).dataset["copyText"] || "";
              navigator.clipboard.writeText(text);
              const orig = btn.textContent;
              btn.textContent = "Copied!";
              setTimeout(() => {
                btn.textContent = orig;
              }, 1200);
            });
          });

          if (isAtBottom) {
            logsViewer.scrollTop = logsViewer.scrollHeight;
          }
        } else {
          logsViewer.innerHTML = `<span style="color: var(--text-secondary)">Waiting for logs...</span>`;
        }
      } catch {
        logsViewer.innerHTML = `<span style="color: var(--text-secondary)">No logs available</span>`;
      }
    }

    if (runStatus.innerText !== status) {
      runStatus.innerText = status;
      runStatus.className = `status-badge status-${status}`;
      runStatus.style.display = "inline-block";
    }

    if (status === "Running" && stopRunBtn) {
      stopRunBtn.style.display = "inline-flex";
    } else if (stopRunBtn) {
      stopRunBtn.style.display = "none";
    }

    // Show retry button only for failed runs
    if (status === "Failed" && retryRunBtn) {
      retryRunBtn.style.display = "inline-flex";
    } else if (retryRunBtn) {
      retryRunBtn.style.display = "none";
    }

    // Stop polling once we reach a terminal state
    const isTerminal = status === "Passed" || status === "Failed";
    if (isTerminal && statusPollTimer !== null) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
    // Always refresh timeline when loading logs
    loadTimeline();
    // Load error summary from structured API
    loadErrorSummary();
  }
}

/** Fetch structured errors from the server API and render the error summary panel. */
async function loadErrorSummary() {
  if (!activeRunId || !errorSummaryEl) {
    return;
  }
  try {
    const annotations: Array<{
      severity: string;
      message: string;
      line: number;
      context: string[];
    }> = await rpc.request.getRunErrors({ runId: activeRunId });

    if (annotations.length === 0) {
      errorSummaryEl.style.display = "none";
      return;
    }

    const errors = annotations.filter((a) => a.severity === "error");
    const warnings = annotations.filter((a) => a.severity === "warning");

    const countBadges: string[] = [];
    if (errors.length > 0) {
      countBadges.push(
        `<span class="error-summary-count">${errors.length} error${errors.length > 1 ? "s" : ""}</span>`,
      );
    }
    if (warnings.length > 0) {
      countBadges.push(
        `<span class="warning-summary-count">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>`,
      );
    }

    const items = annotations
      .map((a) => {
        const severityCls = a.severity === "error" ? "error" : "warning";
        const itemCls = a.severity === "warning" ? " error-summary-item-warning" : "";
        return `<div class="error-summary-item${itemCls}" data-error-line="${a.line}">
          <span class="error-summary-severity error-summary-severity-${severityCls}">${a.severity}</span>
          <span class="error-summary-message">${a.message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</span>
          <span class="error-summary-line">L${a.line}</span>
        </div>`;
      })
      .join("");

    errorSummaryEl.innerHTML = `
      <div class="error-summary-header">
        <div class="error-summary-title">
          <span class="error-summary-toggle">▶</span>
          Annotations ${countBadges.join(" ")}
        </div>
        <div class="error-summary-actions">
          <button class="error-summary-copy">Copy All</button>
        </div>
      </div>
      <div class="error-summary-list">${items}</div>
    `;
    errorSummaryEl.style.display = "block";
    errorSummaryEl.classList.remove("collapsed");

    // Toggle collapse
    const header = errorSummaryEl.querySelector(".error-summary-header");
    header?.addEventListener("click", (e) => {
      // Don't toggle if clicking the copy button
      if ((e.target as HTMLElement).classList.contains("error-summary-copy")) {
        return;
      }
      errorSummaryEl!.classList.toggle("collapsed");
    });

    // Copy all errors
    const copyBtn = errorSummaryEl.querySelector(".error-summary-copy");
    copyBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const allMessages = annotations
        .map((a) => `[${a.severity.toUpperCase()}] ${a.message}`)
        .join("\n");
      const pathLine = activeLogsPath ? `\n\nLogs: ${activeLogsPath}` : "";
      navigator.clipboard.writeText(allMessages + pathLine);
      if (copyBtn) {
        const orig = copyBtn.textContent;
        copyBtn.textContent = "Copied!";
        setTimeout(() => {
          copyBtn.textContent = orig;
        }, 1200);
      }
    });

    // Click-to-scroll for each error item
    errorSummaryEl.querySelectorAll(".error-summary-item").forEach((item) => {
      item.addEventListener("click", () => {
        const targetLine = (item as HTMLElement).dataset["errorLine"];
        if (targetLine && logsViewer) {
          const lineEl = logsViewer.querySelector(`[data-log-line="${targetLine}"]`);
          if (lineEl) {
            (lineEl as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
            // Brief highlight
            lineEl.classList.add("log-line-error");
            setTimeout(() => lineEl.classList.remove("log-line-error"), 2000);
          }
        }
      });
    });
  } catch {
    // Errors API not available yet
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();

  // Read runId from the shared bun process (set by commits page via setActiveRunId RPC)
  // Note: Electrobun's views:// protocol treats query params and hash fragments as part
  // of the file path, so we use RPC to pass state between views instead.
  activeRunId = await rpc.request.getActiveRunId();

  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  const openInFinderBtn = document.getElementById("open-in-finder-btn");
  if (openInFinderBtn && activeRunId) {
    openInFinderBtn.addEventListener("click", () => {
      rpc.request.openRunInFinder({ runId: resolvedRunnerName || activeRunId! });
    });
  }

  if (workflowLabel) {
    // Show "Run {number} - {jobName}" once detail loads; raw ID as initial placeholder
    workflowLabel.innerText = `Run ${activeRunId || "Unknown"}`;
    rpc.request
      .getRunDetail({ runId: activeRunId || "" })
      .then((d: any) => {
        if (d) {
          const label = formatRunnerName(d.runnerName || activeRunId || "")
            .replace("#", "")
            .trim();
          const jobSuffix = d.jobName ? ` - ${d.jobName}` : "";
          workflowLabel.innerText = `${label}${jobSuffix}`;
        }
      })
      .catch(() => {});
  }

  if (stopRunBtn) {
    stopRunBtn.addEventListener("click", async () => {
      stopRunBtn.setAttribute("disabled", "true");
      await apiPost("/workflows/stop", { runId: getAppState().runId });
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
      await loadLogs();
    });
  }

  if (retryRunBtn) {
    retryRunBtn.addEventListener("click", async () => {
      retryRunBtn.style.display = "none"; // Hide immediately
      try {
        const data = await apiPost<{ runnerName?: string }>("/workflows/retry", {
          runId: activeRunId,
        });
        if (data.runnerName) {
          await rpc.request.setActiveRunId({ runId: data.runnerName });
          window.location.reload();
        }
      } catch {
        retryRunBtn.style.display = "inline-flex"; // Show again on error
      }
    });
  }

  initGlobalErrorHandler();

  const initDetails = await rpc.request.getRunDetail({ runId: activeRunId || "" });
  // Always do the initial full log load regardless of status.

  await loadLogs();

  // Poll status every 2s while not in a terminal state (catches the window
  // where Docker container hasn't started yet so status would show Unknown)
  const isTerminalStatus = (s: string) => s === "Passed" || s === "Failed";
  if (!isTerminalStatus(initDetails?.status ?? "")) {
    statusPollTimer = setInterval(async () => {
      await loadLogs();
    }, 2000);
  } else {
    // Terminal run - nothing extra to poll
  }

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
        if (data.type === "runFinished") {
          if (statusPollTimer !== null) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
          }
          loadLogs();
          setTimeout(() => loadTimeline(), 1500);
        }
        if (data.type === "runStarted") {
          loadLogs();
        }
      } catch {}
    });
  } catch {}
});

// Global keyboard shortcuts
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
  // Cmd+C / Ctrl+C — copy selected text to clipboard
  if ((e.metaKey || e.ctrlKey) && e.key === "c") {
    const selection = window.getSelection();
    const text = selection?.toString();
    if (text) {
      navigator.clipboard.writeText(text);
    }
  }
});
window.addEventListener("pointerdown", (e) => {
  if (e.button === 3) {
    e.preventDefault();
    window.history.back();
  }
});
