import { getAppState, getAppStateAsync } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { AnsiUp } from "ansi_up";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";

const ansiUp = new AnsiUp();

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

let activeRunId: string | null = null;
let isStreamingLogs = false;
let runStartDate: number = 0;
let runEndDate: number | undefined;

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
const runStatsBar = document.getElementById("run-stats-bar");
const runStatsPanel = document.getElementById("run-stats-panel") as HTMLElement | null;
const cpuCanvas = document.getElementById("chart-cpu") as HTMLCanvasElement | null;
const memCanvas = document.getElementById("chart-mem") as HTMLCanvasElement | null;

let statsPollTimer: ReturnType<typeof setInterval> | null = null;
let statsHistory: Array<{ ts: number; cpu: number; memMB: number }> = [];

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
  const h = 60;
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
}

async function loadStats() {
  if (!activeRunId) {
    return;
  }
  try {
    const [stats, history] = await Promise.all([
      fetch("http://localhost:8912/runs/stats?runId=" + encodeURIComponent(activeRunId)).then((r) =>
        r.json(),
      ),
      fetch(
        "http://localhost:8912/runs/stats/history?runId=" + encodeURIComponent(activeRunId),
      ).then((r) => r.json()),
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

    if (runStatsBar && pills.length > 0) {
      runStatsBar.innerHTML = pills.join("");
    }

    if (runStatsPanel && (statsHistory.length > 0 || pills.length > 0)) {
      runStatsPanel.style.display = "flex";
      redrawCharts();
    }
  } catch {
    // Stats not available yet
  }
}

/** Called from SSE handler to append a live sample without a full fetch. */
function appendStatSample(sample: { ts: number; cpu: number; memMB: number }) {
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

  const details = await fetch(
    "http://localhost:8912/runs?runId=" + encodeURIComponent(activeRunId),
  ).then((r) => r.json());
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
    // Fetch log content when not actively streaming
    if (!isStreamingLogs) {
      try {
        const logs = await fetch(
          "http://localhost:8912/runs/logs?runId=" + encodeURIComponent(activeRunId),
        ).then((r) => r.text());
        if (logs) {
          const isAtBottom =
            logsViewer.scrollHeight - logsViewer.scrollTop - logsViewer.clientHeight < 10;
          logsViewer.innerHTML = "<pre>" + ansiUp.ansi_to_html(logs) + "</pre>";
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
      await fetch("http://localhost:8912/workflows/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId: getAppState().runId }),
      });
      stopRunBtn.style.display = "none";
      stopRunBtn.removeAttribute("disabled");
      await loadLogs();
    });
  }

  const initDetails = await fetch(
    "http://localhost:8912/runs?runId=" + encodeURIComponent(activeRunId || ""),
  ).then((r) => r.json());
  if (initDetails?.status === "Running") {
    isStreamingLogs = true;
  }

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
          isStreamingLogs = false;
          if (statusPollTimer !== null) {
            clearInterval(statusPollTimer);
            statusPollTimer = null;
          }
          if (statsPollTimer !== null) {
            clearInterval(statsPollTimer);
            statsPollTimer = null;
          }
          loadLogs();
          // Final stats fetch to show peak values after run completes
          setTimeout(() => loadStats(), 1000);
        }
        if (data.type === "runStarted") {
          loadLogs();
        }
        // Live stats sample via SSE
        if (data.type === "runStatsSample" && data.runId === activeRunId) {
          appendStatSample({ ts: data.ts, cpu: data.cpu, memMB: data.memMB });
        }
        // Live log streaming via SSE
        if (data.type === "runLog" && data.runId === activeRunId && logsViewer) {
          isStreamingLogs = true;
          const isAtBottom =
            logsViewer.scrollHeight - logsViewer.scrollTop - logsViewer.clientHeight < 10;
          const line = document.createElement("div");
          line.innerHTML = ansiUp.ansi_to_html(data.line);
          logsViewer.appendChild(line);
          if (isAtBottom) {
            logsViewer.scrollTop = logsViewer.scrollHeight;
          }
        }
      } catch {}
    });
  } catch {}
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
