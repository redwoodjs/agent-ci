import { setAppState } from "./state.ts";
import ElectrobunView from "electrobun/view";
import type { MyRPCSchema } from "../shared/rpc.ts";
import { initSseAuditLog, recordSseEvent } from "./sse-audit-log.ts";

const rpc = ElectrobunView.Electroview.defineRPC<MyRPCSchema>({
  maxRequestTime: 15000,
  handlers: { requests: {}, messages: {} },
});

new ElectrobunView.Electroview({ rpc });

async function goToBranches(repoPath: string) {
  await setAppState({ repoPath });
  window.location.href = "views://branches/index.html";
}

// Reload when navigating back via bfcache (e.g. history.back())
window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    window.location.reload();
  }
});

document.addEventListener("DOMContentLoaded", async () => {
  initSseAuditLog();
  const recentList = document.getElementById("recent-repos-list");
  if (recentList) {
    try {
      const recent = await fetch("http://localhost:8912/repos").then((r) => r.json());
      if (recent.length > 0) {
        recent.forEach((repoPath: string, idx: number) => {
          const item = document.createElement("div");
          item.className = "list-item animate-fade-in";
          item.style.animationDelay = `${idx * 0.05}s`;
          item.style.display = "flex";
          item.style.justifyContent = "space-between";
          item.style.alignItems = "center";

          const text = document.createElement("div");
          text.className = "list-item-title";
          text.innerText = repoPath;
          item.appendChild(text);

          const removeBtn = document.createElement("button");
          removeBtn.innerText = "Remove";
          removeBtn.className = "btn";
          removeBtn.style.padding = "4px 8px";
          removeBtn.style.fontSize = "12px";
          removeBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await fetch("http://localhost:8912/repos", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ repoPath }),
            });
            window.location.reload();
          });
          item.appendChild(removeBtn);

          item.addEventListener("click", () => goToBranches(repoPath));
          recentList.appendChild(item);
        });
      } else {
        recentList.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">No recent repos. Click "Open Repo..." to get started.</div>`;
      }
    } catch {
      recentList.innerHTML = `<div style="color: var(--text-secondary); text-align: center; padding: 32px">Loading...</div>`;
      // Retry shortly
      setTimeout(() => window.location.reload(), 1000);
      return; // wait for reload
    }
  }

  const selectBtn = document.getElementById("select-repo-btn");
  if (selectBtn) {
    selectBtn.addEventListener("click", async () => {
      selectBtn.setAttribute("disabled", "true");
      try {
        const selectedPath = await rpc.request.selectRepo();
        if (selectedPath) {
          await fetch("http://localhost:8912/repos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoPath: selectedPath }),
          });
          goToBranches(selectedPath);
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
