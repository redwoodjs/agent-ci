---
title: Extracted UI Backend Logic to Node Supervisor Daemon & Fixed DTU Status Liveness
date: 2026-02-28 09:10
author: peterp
---

# Extracted UI Backend Logic to Node Supervisor Daemon & Fixed DTU Status Liveness

## Summary

Refactored the application architecture by moving all orchestrating logic, git file system access, and Docker lifecycle management from the tightly-coupled `ui/src/bun/index.ts` backend into a standalone long-running `supervisor server` package. Re-wired the DTU (`dtu-github-actions`) to be managed natively by this daemon, replacing fake UI states with real-time process monitoring.

## The Problem

The `ui` package was functioning as a thick client, directly executing backend processes and managing state, violating the principle of a "dumb terminal" UI.

Following extraction, when launching the UI, the DTU status was perpetually stuck on `DTU: Checking...` or failing silently because the React Component `fetch` calls to the newly created `http://localhost:8912/repos` supervisor endpoints were throwing `Connection Refused` unhandled promise rejections on page load, aborting the rest of the JS execution before event listeners could attach.

## Investigation & Timeline

- **Initial State:**
  - The UI interacted with the backend exclusively via Electrobun IPC RPC calls.
  - DTU liveness "Running" state was hardcoded in the frontend components (`const status = "Running";`).
- **Attempts:**
  - _Extracting Logic_: Bootstrapped full `polka` server in `supervisor/src/server/index.ts`. All `git` logic, `recent-repos.json` reads, and docker container orchestrations were moved into standard HTTP endpoints.
  - _Fixing UI Boot Aborts_: Wrapped the `DOMContentLoaded` fetch initializers in `try/catch` and `setTimeout(window.location.reload(), 1000)` to elegantly retry checking for the supervisor API if the Chrome window launched faster than the backend node process binded its port.
  - _Wiring DTU Logic_: Added explicit `GET /dtu`, `POST /dtu`, `DELETE /dtu` endpoints to the server alongside `getDtuStatus()`, `startDtu()`, and `stopDtu()` lifecycle functions that spawn `pnpm --filter dtu-github-actions dev`.
  - _Real-time SSE Events_: Switched UI components from a 3000ms `setInterval` polling loop over to an asynchronous `EventSource` web-socket-style listener for immediate reaction to state changes.

## Discovery & Key Findings

- We realized the "Open Repo" RPC handler was also broken in earlier commits because the `Connection Refused` promise rejection interrupted the addition of the DOM click listener to the button.
- A failed or missing child process for the DTU requires explicitly clearing orphaned ports (e.g. `lsof -t -i :8910` and `kill -9`) before re-spawning, which was added to the `stopDtu` cleanup block for stability.
- The UI handles states `Stopped`, `Starting`, `Running`, but we learned it needs a dedicated `Error / Failed` state to allow the user to click the button and retry spinning up the node execution if the background task dies.

## Resolution

The architecture now relies on the `ui` acting strictly as a visual presentation layer that issues HTTP / REST commands, with backend responsibilities exclusively managed by the `/supervisor`. The UI components explicitly observe and mutate the `dtu-github-actions` lifecycle over robust `EventSource` Server-Sent Events.

## Next Steps

- [ ] Add `GET /audit` endpoint to supervisor to return the event history
- [ ] Add event ring-buffer memory logic to `orchestrator.ts` broadcastEvent
- [ ] Create `ui/src/mainview/audit.html`, `.ts`, and `.css`
- [ ] Link to the new Audit Log view from all UI headers
