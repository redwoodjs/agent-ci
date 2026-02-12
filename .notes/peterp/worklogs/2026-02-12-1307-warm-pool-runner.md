---
title: Implementing Warm Pool for GitHub Actions Runner
date: 2026-02-12 13:07
author: peterp
---

# Implementing Warm Pool for GitHub Actions Runner

## Summary
We implemented a "warm pool" strategy for the local runner. Instead of spinning up a container *after* receiving a job, the runner now maintains a persistent, ready-to-go Docker container (`warm-runner`) that constantly listens for jobs. This reduces latency and ensures immediate availability.

## The Problem
The primary constraint effectively requires a long-running poller for each job. Spinning up containers reactively meant we weren't maintaining the persistent connection GitHub expects for instant job assignment. We needed a strategy where a container is pre-warmed, authenticated, and holding that connection open.

## Investigation & Timeline
* **Initial State:** The `runner` package had a simple polling loop in `index.ts` that called `executeJob` upon finding work.
* **Attempts:**
    * **Plan:** We designed a `warm-pool.ts` module to replace the polling loop.
    * **Persistence:** We created `runner/_/identity` to store runner credentials (`.runner`, `.credentials`) and `runner/_/work` for the workspace. This ensures the runner ID persists across container restarts.
    * **Execution:** We switched from `spawn` (shelling out to CLI) to `dockerode` for better programmatic control.
    * **Challenges:**
        * **Missing Image:** The runner failed initially because the `ghcr.io/actions/actions-runner:latest` image wasn't pulled. We added auto-pull logic.
        * **Command Failure:** Running with just `["--once"]` failed because the image entrypoint wasn't set up as expected. We changed it to explicit `["/home/runner/run.sh", "--once"]`.
        * **Volume Masking:** Mounting the entire `_/identity` directory to `/home/runner` hid the runner binaries (like `run.sh`). We fixed this by mounting only the specific config files (`.runner`, `.credentials`).

## Discovery & Key Findings
* **Volume Granularity:** When mapping configuration files into a Docker container that already contains binaries in the same directory, you must mount specific files, not the parent directory.
* **Entrypoints:** The `actions-runner` image requires explicit invocation of the start script when overriding the default command.
* **Bridge Announcement:** The runner needs to announce its presence ("I'm here") even if it's not actively polling for specific job IDs in the old way. We reused `pollJobs()` for this heartbeat.

## Resolution
We created `src/warm-pool.ts` which:
1.  Checks for a `warm-runner` container every 10 seconds.
2.  Spawns a new one if missing or dead.
3.  Mounts persistent identity and workspace volumes.
4.  Announces availability to the Bridge.

The `src/index.ts` was updated to delegates control to `startWarmPool()`.

## Next Steps
- [ ] Implement job claiming logic within the warm container (currently it just listens).
- [ ] Handle job completion and container rotation (ensure clean state for next job).
