import { getAppState, getAppStateAsync, setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { AnsiUp } from "ansi_up";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
import { api, apiPost } from "./api.ts";
import { initGlobalErrorHandler } from "./global-error-handler.ts";

const ansiUp = new AnsiUp();

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let activeRunId: string | null = null;
let runStartDate: number = 0;
let runEndDate: number | undefined;
let activeStepId: string | null = null;

function formatElapsed(startMs: number, endMs?: number): string {
  const elapsed = Math.max(0, ((endMs ?? Date.now()) - startMs) / 1000);
  if (elapsed < 60) {
    return `${Math.round(elapsed)}s`;
  }
  const mins = Math.floor(elapsed / 60);
  const secs = Math.round(elapsed % 60);
  return `${mins}m ${secs}s`;
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
const runStatsBar = document.getElementById("run-stats-bar");
const runStatsPanel = document.getElementById("run-stats-panel") as HTMLElement | null;
const cpuCanvas = document.getElementById("chart-cpu") as HTMLCanvasElement | null;
const memCanvas = document.getElementById("chart-mem") as HTMLCanvasElement | null;
const netCanvas = document.getElementById("chart-net") as HTMLCanvasElement | null;
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
    const records: TimelineRecord[] = await api(
      "/runs/timeline?runId=" + encodeURIComponent(activeRunId),
    );
    renderStepList(records);
  } catch {
    // timeline not available yet
  }
}

let statsPollTimer: ReturnType<typeof setInterval> | null = null;
let statsHistory: Array<{
  ts: number;
  cpu: number;
  memMB: number;
  netRxMB?: number;
  netTxMB?: number;
}> = [];

function formatMB(mb: number): string {
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

function statPill(icon: string, label: string, value: string, live = false): string {
  const dot = live ? ' <span style="color:#4ade80;font-size:9px">●</span>' : "";
  return `<span style="display:inline-flex;align-items:center;gap:4px;background:var(--panel-bg);border:1px solid var(--panel-border);border-radius:4px;padding:2px 8px">${icon} <span style="color:var(--text-primary)">${value}</span>${dot} <span style="opacity:0.6">${label}</span></span>`;
}

function drawSparkline(
  canvas: HTMLCanvasElement,
  data: number[],
  maxVal: number,
  lineColor: string,
  fillColor: string,
  yLabel: (v: number) => string,
) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.offsetWidth || 200;
  const h = 36;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.scale(dpr, dpr);

  const padL = 38,
    padR = 8,
    padT = 6,
    padB = 4;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const eMax = maxVal > 0 ? maxVal * 1.2 : 1;

  // Grid lines + y-axis labels
  for (let i = 0; i <= 2; i++) {
    const y = padT + (ih * i) / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.font = "9px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(yLabel(eMax * (1 - i / 2)), padL - 3, y + 3);
  }

  if (data.length < 2) {
    return;
  }

  const toX = (i: number) => padL + i * (iw / (data.length - 1));
  const toY = (v: number) => padT + ih * (1 - Math.min(v, eMax) / eMax);

  // Filled area
  ctx.beginPath();
  ctx.moveTo(toX(0), padT + ih);
  for (let i = 0; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(data[i]));
  }
  ctx.lineTo(toX(data.length - 1), padT + ih);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(toX(0), toY(data[0]));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(toX(i), toY(data[i]));
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Latest dot
  const lx = toX(data.length - 1),
    ly = toY(data[data.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();
}

function redrawCharts() {
  if (statsHistory.length === 0) {
    return;
  }
  const cpuData = statsHistory.map((s) => s.cpu);
  const memData = statsHistory.map((s) => s.memMB);
  if (cpuCanvas) {
    drawSparkline(
      cpuCanvas,
      cpuData,
      Math.max(...cpuData),
      "#60a5fa",
      "rgba(96,165,250,0.15)",
      (v) => `${Math.round(v)}%`,
    );
  }
  if (memCanvas) {
    drawSparkline(
      memCanvas,
      memData,
      Math.max(...memData),
      "#a78bfa",
      "rgba(167,139,250,0.15)",
      (v) => formatMB(Math.round(v)),
    );
  }
  const netData = statsHistory.map((s) => (s.netRxMB ?? 0) + (s.netTxMB ?? 0));
  if (netCanvas && netData.some((v) => v > 0)) {
    drawSparkline(
      netCanvas,
      netData,
      Math.max(...netData),
      "#34d399",
      "rgba(52,211,153,0.15)",
      (v) => formatMB(Math.round(v)),
    );
  }
}

async function loadStats() {
  if (!activeRunId) {
    return;
  }
  try {
    const [stats, history] = await Promise.all([
      api("/runs/stats?runId=" + encodeURIComponent(activeRunId)),
      api("/runs/stats/history?runId=" + encodeURIComponent(activeRunId)),
    ]);

    statsHistory = history;

    const pills: string[] = [];
    if (stats.live && stats.cpu !== undefined) {
      pills.push(statPill("⚡", "CPU", `${stats.cpu}%`, true));
    } else if (stats.peakCpu !== undefined) {
      pills.push(statPill("⚡", "peak CPU", `${stats.peakCpu}%`));
    }
    if (stats.live && stats.memMB !== undefined) {
      pills.push(statPill("🧠", "mem", formatMB(stats.memMB), true));
    } else if (stats.peakMemMB !== undefined) {
      pills.push(statPill("🧠", "peak mem", formatMB(stats.peakMemMB)));
    }
    if (stats.imageSizeMB !== undefined) {
      pills.push(statPill("📦", "image", formatMB(stats.imageSizeMB)));
    }
    if (stats.live && stats.netRxMB !== undefined && stats.netTxMB !== undefined) {
      pills.push(
        statPill("📡", "net", `↓${formatMB(stats.netRxMB)} ↑${formatMB(stats.netTxMB)}`, true),
      );
    } else if (stats.peakNetRxMB !== undefined && stats.peakNetTxMB !== undefined) {
      pills.push(
        statPill("📡", "net", `↓${formatMB(stats.peakNetRxMB)} ↑${formatMB(stats.peakNetTxMB)}`),
      );
    }

    if (runStatsBar && pills.length > 0) {
      runStatsBar.innerHTML = pills.join("");
    }

    if (runStatsPanel && (statsHistory.length > 0 || pills.length > 0)) {
      runStatsPanel.style.display = "block";
      redrawCharts();
    }
  } catch {
    // Stats not available yet
  }
}

/** Called from SSE handler to append a live sample without a full fetch. */
function appendStatSample(sample: {
  ts: number;
  cpu: number;
  memMB: number;
  netRxMB?: number;
  netTxMB?: number;
}) {
  if (statsHistory.length > 0 && statsHistory[statsHistory.length - 1].ts === sample.ts) {
    return;
  }
  statsHistory.push(sample);
  redrawCharts();
}

async function loadLogs() {
  if (!activeRunId) {
    return;
  }

  const details = await api("/runs?runId=" + encodeURIComponent(activeRunId));
  const status = details.status || "Unknown";

  if (details.date && !runStartDate) {
    runStartDate = details.date;
  }
  if (details.endDate) {
    runEndDate = details.endDate;
  }

  if (runTitle) {
    const elapsed = runStartDate ? ` · ${formatElapsed(runStartDate, runEndDate)}` : "";
    runTitle.innerText = `${details.runnerName || activeRunId}${elapsed}`;
  }

  // Load container stats (fire-and-forget, non-blocking)
  loadStats();

  if (details && logsViewer && runStatus) {
    // Fetch log content from the API
    {
      try {
        const res = await fetch(
          "http://localhost:8912/runs/logs?runId=" + encodeURIComponent(activeRunId),
        );
        const logs = await res.text();
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
    if (isTerminal && statsPollTimer !== null) {
      clearInterval(statsPollTimer);
      statsPollTimer = null;
      // Load stats one final time to show peak values
      loadStats();
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
    }> = await api("/runs/errors?runId=" + encodeURIComponent(activeRunId));

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
      navigator.clipboard.writeText(allMessages);
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
  const state = await getAppStateAsync();
  activeRunId = state.runId;

  if (backBtn) {
    backBtn.addEventListener("click", () => window.history.back());
  }

  if (workflowLabel) {
    workflowLabel.innerText = `Run ${activeRunId || "Unknown"}`;
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
          await setAppState({ runId: data.runnerName });
          window.location.reload();
        }
      } catch {
        retryRunBtn.style.display = "inline-flex"; // Show again on error
      }
    });
  }

  initGlobalErrorHandler();

  const initDetails = await api("/runs?runId=" + encodeURIComponent(activeRunId || ""));
  // Always do the initial full log load regardless of status.

  await loadLogs();

  // Poll status every 2s while not in a terminal state (catches the window
  // where Docker container hasn't started yet so status would show Unknown)
  const isTerminalStatus = (s: string) => s === "Passed" || s === "Failed";
  if (!isTerminalStatus(initDetails?.status)) {
    statusPollTimer = setInterval(async () => {
      await loadLogs();
    }, 2000);
    // Also poll stats every 5s while running
    statsPollTimer = setInterval(async () => {
      await loadStats();
    }, 5000);
  } else {
    // Still load stats once for terminal runs (shows peak + image size)
    loadStats();
  }

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
  }

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
        if (data.type === "dtuStatusChanged") {
          pollDtuStatus();
        }
        if (data.type === "runFinished") {
          if (statusPollTimer !== null) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
          }
          if (statsPollTimer !== null) {
            clearInterval(statsPollTimer);
            statsPollTimer = null;
          }
          loadLogs();
          // Final stats + timeline fetch after run completes
          setTimeout(() => loadStats(), 1000);
          setTimeout(() => loadTimeline(), 1500);
        }
        if (data.type === "runStarted") {
          loadLogs();
        }
        // Live stats sample via SSE
        if (data.type === "runStatsSample" && data.runId === activeRunId) {
          appendStatSample({
            ts: data.ts,
            cpu: data.cpu,
            memMB: data.memMB,
            netRxMB: data.netRxMB,
            netTxMB: data.netTxMB,
          });
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
