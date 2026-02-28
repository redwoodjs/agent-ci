const API_BASE = "http://localhost:8912";

export function getAppState() {
  // Synchronous fallback from localStorage
  try {
    const raw = localStorage.getItem("oa-state");
    if (raw) {
      return JSON.parse(raw);
    }
  } catch {}
  return {
    repoPath: "",
    branchName: "",
    commitId: "WORKING_TREE",
    workflowId: "",
    runId: "",
  };
}

export async function getAppStateAsync() {
  try {
    const res = await fetch(`${API_BASE}/ui-state`);
    if (res.ok) {
      const serverState = await res.json();
      if (serverState && Object.keys(serverState).length > 0) {
        return {
          repoPath: "",
          branchName: "",
          commitId: "WORKING_TREE",
          workflowId: "",
          runId: "",
          ...serverState,
        };
      }
    }
  } catch {}
  return getAppState();
}

export async function setAppState(updates: Record<string, string>) {
  // Write to localStorage as fallback
  const current = getAppState();
  const next = { ...current, ...updates };
  try {
    localStorage.setItem("oa-state", JSON.stringify(next));
  } catch {}

  // Write to server (primary)
  try {
    await fetch(`${API_BASE}/ui-state`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
  } catch {}
}
