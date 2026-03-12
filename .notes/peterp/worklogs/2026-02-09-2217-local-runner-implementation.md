---
title: Implementing Local Runner Agent
date: 2026-02-09 22:17
author: peterp
---

# Implementing Local Runner Agent

## Summary

We implemented the `agent-ci-runner` as a local Node.js process that polls the Cloudflare Worker Bridge for jobs. We unified the Polling and Heartbeat mechanisms into a single API call to simplify the architecture. Execution is currently stubbed.

## The Problem

We needed a local agent to execute tasks (like Docker containers) that the Cloudflare Worker cannot handle directly. The agent needs to pick up jobs from the Bridge and report its presence.

## Investigation & Timeline

- **Initial State:** Empty `agent-ci-runner` directory.
- **Attempts:**
  - Scaffolded a TypeScript Node.js project.
  - Implemented configuration using `zod` (Bridge URL, GitHub Username, API Key).
  - Implemented a polling loop that fetches jobs from `${BRIDGE_URL}/jobs`.
  - **Mechanism Change:** Merged "Heartbeat" into the "Poll" request. The Bridge now updates user presence ("online") whenever the runner polls for jobs.
  - Encountered issues running `pnpm` in the remote sandbox environment due to permission errors.
  - Verified the runner logic using `npm run dev` (which executes `tsc` and `node` directly).

## Discovery & Key Findings

- **Simplified Presence:** We don't need a separate heartbeat loop; polling for work is a strong signal of presence.
- **Environment Constraints:** The sandbox environment has specific restrictions on package managers (`pnpm` binary execution issues), but the underlying code is manager-agnostic.

## Resolution

- **Runner Implemented:** `agent-ci-runner` is ready.
- **Bridge Updated:** `GET /jobs` now accepts `username` and updates KV presence.
- **Verification:** Validated that the runner polls correctly and handles connection errors gracefully.

## Next Steps

- [ ] Implement actual Docker execution logic in `executor.ts`.
- [ ] Add persistence for failed jobs (retry logic/dead letter queue).
- [ ] Secure the API with the API Key (currently optional).
