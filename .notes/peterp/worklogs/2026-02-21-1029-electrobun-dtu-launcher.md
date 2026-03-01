---
title: Building the Electrobun DTU Launcher
date: 2026-02-21 10:29
author: peterp
---

# Building the Electrobun DTU Launcher

## Summary

We implemented an integrated "Launch DTU" interface within an existing Electrobun desktop application. This interface allows the user to start and stop the DTU server right from the desktop UI. Along the way, we added live log streaming and robust TCP port polling to ensure the status correctly reflects when the DTU is actually ready.

## The Problem

The initial goal was simple: "add a button that allows us to launch the DTU and show the status that it's online."

However, implementing it highlighted several deeper technical requirements:

- The UI runs in a Webview, while the DTU requires a Node/Bun process to be spawned. Thus, Inter-Process Communication (IPC) was necessary.
- Firing off a command with an arbitrary `sleep` delay caused the RPC request to timeout.
- The UI was completely opaque regarding what the background DTU server was actually doing.

## Investigation & Timeline

- **Initial State:** The repository had a basic Electrobun UI (`ui/`) and a GitHub Actions DTU backend (`dtu-github-actions/`). The UI was just a static placeholder.
- **Attempts:**
  - **Attempt 1: Basic IPC Setup**
    We added an Electrobun RPC schema and a `launchDTU` handler invoking `Bun.spawn` with an artificial 3-second delay to "guarantee" availability. The Javascript file didn't execute at all because the UI was missing the `<script src="index.js"></script>` tag in its HTML!
    _Result:_ Button dead initially. Added the script tag, but then the request returned "Error".
  - **Attempt 2: Fixing the Timeout & Adding Log Streaming**
    The artificial 3-second delay was tripping Electrobun's default 1000ms RPC timeout. We removed the delay and instead piped `stdout` and `stderr` directly to a new RPC push message (`dtuLog`) so the frontend could stream the logs.
    _Result:_ Status switched to "Online", but it did so _instantly_, without confirming the DTU was actually bound and listening.
  - **Attempt 3: Port Polling & Stop Functionality**
    To be absolutely certain, we increased `maxRequestTime` to `15000ms` and implemented a `node:net` socket polling loop on port `8910`. We also mapped state logic to swap the button to a "Stop DTU" action capable of sending a Unix kill signal to the tracked `dtuProc`.
    _Result:_ Success! The button now hangs in an orange "Starting..." state while polling the socket, streaming the logs concurrently. Once the socket connects, it cleanly transitions to green "Online".

## Discovery & Key Findings

1. **Electrobun RPC Strictness:** Electrobun utilizes a strongly-typed, separate schema (`RPCSchema`) for bridging Bun and WebViews. When defining it, we must specify the exact context (`"bun"` vs `"webview"`) so TS infers union handlers correctly.
2. **IPC Timeouts by Default:** Electrobun RPC requests are strictly bounded by a `maxRequestTime` of `1000ms` by default. If your handler awaits a sub-process or a long network request, you _must_ configure it to be higher.
3. **Piping Output over RPC:** You can attach standard Web Streams (`stream.getReader()`) over a `Bun.spawn` output to forward chunk streams in real-time, functioning exactly as a virtual terminal inside a Webview.

## Resolution

We successfully wired the UI and Backend using an Electrobun RPC Schema.

- **Backend:** `bun/index.ts` holds a global reference to `dtuProc = Bun.spawn(...)`. It polls port `8910` via `net.Socket` before finalizing the RPC request.
- **Frontend:** `mainview/index.ts` manages a toggle state for "Start" and "Stop". Incoming chunk logs via `dtuLog` channel are appended to a `<div id="dtu-logs">` and scrolled to the bottom.

## Next Steps

- [ ] Add the Supervisor to the UI so it can also be started and stopped in the same manner.
- [ ] Add color syntax highlighting / ANSI parsing to the parsed logs block to respect original terminal colors.
