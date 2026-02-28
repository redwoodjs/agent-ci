/**
 * SSE Audit Log — shared in-memory event logger for the top-bar dropdown.
 *
 * Usage:
 *   import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";
 *   initSseAuditLog();
 *   // inside EventSource message handler:
 *   recordSseEvent(data);
 */

interface SseEvent {
  time: Date;
  type: string;
  data: any;
}

const sseEvents: SseEvent[] = [];

function getTypeClass(type: string): string {
  if (type.toLowerCase().includes("dtu")) {
    return "sse-audit-type-dtu";
  }
  if (type.toLowerCase().includes("branch")) {
    return "sse-audit-type-branch";
  }
  if (type.toLowerCase().includes("commit")) {
    return "sse-audit-type-commit";
  }
  if (type.toLowerCase().includes("run")) {
    return "sse-audit-type-run";
  }
  return "sse-audit-type-default";
}

function formatTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function renderAuditList() {
  const list = document.getElementById("sse-audit-list");
  if (!list) {
    return;
  }

  if (sseEvents.length === 0) {
    list.innerHTML = `<div class="sse-audit-empty">No events captured yet</div>`;
    return;
  }

  list.innerHTML = "";
  // Render newest first
  for (let i = sseEvents.length - 1; i >= 0; i--) {
    const ev = sseEvents[i];
    const entry = document.createElement("div");
    entry.className = "sse-audit-entry";

    const dataStr = typeof ev.data === "object" ? JSON.stringify(ev.data) : String(ev.data);

    entry.innerHTML = `
      <span class="sse-audit-time">${formatTime(ev.time)}</span>
      <span class="sse-audit-type ${getTypeClass(ev.type)}">${ev.type}</span>
      <span class="sse-audit-data">${dataStr}</span>
    `;
    list.appendChild(entry);
  }
}

function updateCount() {
  const countEl = document.getElementById("sse-audit-count");
  if (countEl) {
    countEl.textContent = String(sseEvents.length);
  }
}

export function recordSseEvent(data: any) {
  const type = data?.type || "unknown";
  sseEvents.push({ time: new Date(), type, data });
  updateCount();

  // If the panel is currently visible, re-render
  const panel = document.getElementById("sse-audit-panel");
  if (panel && panel.style.display !== "none") {
    renderAuditList();
  }
}

export function initSseAuditLog() {
  const btn = document.getElementById("sse-audit-btn");
  const panel = document.getElementById("sse-audit-panel");
  const clearBtn = document.getElementById("sse-audit-clear");

  if (!btn || !panel) {
    return;
  }

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isVisible = panel.style.display !== "none";
    if (isVisible) {
      panel.style.display = "none";
    } else {
      panel.style.display = "flex";
      renderAuditList();
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      sseEvents.length = 0;
      updateCount();
      renderAuditList();
    });
  }

  // Close panel when clicking outside
  document.addEventListener("click", (e) => {
    if (
      panel.style.display !== "none" &&
      !panel.contains(e.target as Node) &&
      !btn.contains(e.target as Node)
    ) {
      panel.style.display = "none";
    }
  });

  // Show initial empty state
  renderAuditList();
}
