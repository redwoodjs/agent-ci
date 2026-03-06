/**
 * App state shared across views.
 *
 * IMPORTANT — Electrobun cross-view state limitations:
 *
 * 1. localStorage is scoped per views:// origin, so setAppState() on one
 *    page (e.g. views://commits/) does NOT reach another (views://runs/).
 *
 * 2. Electrobun's views:// protocol handler treats BOTH query parameters
 *    AND hash fragments as part of the literal file path. For example:
 *      views://runs/index.html?foo=bar  →  tries to read "index.html?foo=bar"
 *      views://runs/index.html#foo=bar  →  tries to read "index.html#foo=bar"
 *    Both result in ENOENT / "file not found".
 *
 * SOLUTION: Use RPC to pass state through the shared bun process:
 *   - Sender:  await rpc.request.setActiveRunId({ runId })
 *   - Receiver: const runId = await rpc.request.getActiveRunId()
 *   The bun process persists in memory across all view navigations.
 */

import type { MyRPCSchema } from "../shared/rpc.ts";
import type ElectrobunView from "electrobun/view";

type ElectrobunRPC = ReturnType<typeof ElectrobunView.Electroview.defineRPC<MyRPCSchema>>;

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

export async function getAppStateAsync(rpc?: ElectrobunRPC) {
  const local = getAppState();

  if (rpc) {
    try {
      const initialState = await rpc.request.getInitialState();
      const merged = { ...local, ...initialState };
      // Save it back to local storage
      setAppState(merged);
      return merged;
    } catch (e) {
      console.warn("Failed to get initial state from RPC", e);
    }
  }

  return local;
}

export async function setAppState(updates: Record<string, string>) {
  const current = getAppState();
  const next = { ...current, ...updates };
  try {
    localStorage.setItem("oa-state", JSON.stringify(next));
  } catch {}
}
