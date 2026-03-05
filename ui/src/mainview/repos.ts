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

  try {
    const evtSource = new EventSource("http://localhost:8912/events");
    evtSource.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        recordSseEvent(data);
      } catch {}
    });
  } catch {}
});

// Global escape listener
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    window.history.back();
  }
});
