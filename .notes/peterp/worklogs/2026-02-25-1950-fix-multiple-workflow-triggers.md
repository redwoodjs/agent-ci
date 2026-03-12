---
title: Fix multiple workflow triggers on commit
date: 2026-02-25 19:50
author: peterp
---

# Fix multiple workflow triggers on commit

## Summary

Fixed the watch-mode commit listener to trigger all workflows in `.github/workflows/` instead of just the first one. Replaced in-memory process tracking with dynamic `docker ps` polling so run status is derived from reality, not ephemeral state.

## The Problem

When a commit was created on a watched repo, only one workflow ran (e.g. `tests.yml`) even though `smoke_tests.yml` also existed. The root cause was a `break` after the first `.yml` file was found in `enableWatchModeForRepo`. Additionally, a single set of global variables (`supervisorProc`, `activeSupervisorRunId`, etc.) meant only one run could ever be tracked at a time.

## Investigation & Timeline

- **Initial State:** `ui/src/bun/index.ts` iterated workflow files but broke on the first match. A singleton `supervisorProc` variable tracked exactly one active run.
- **Attempts:**
  - First plan: convert singleton variables to a `Map<runId, proc>`. User feedback: state should be dynamic, not stored in memory.
  - Revised plan: poll `docker ps` to determine running status, pre-create `metadata.json` before spawning supervisor so the UI sees the run immediately.

## Discovery & Key Findings

- The supervisor already names Docker containers `agent-ci-runner-N`, making `docker ps --filter name=agent-ci-runner-` a reliable source of truth for running status.
- Pre-creating `metadata.json` before spawning the supervisor process eliminates the race condition where the UI polls before logs flush.
- `stopWorkflow` can target a specific container via `docker rm -f <runId>` rather than killing a remembered process handle.

## Resolution

Refactored `ui/src/bun/index.ts`:

- Removed `supervisorProc`, `activeSupervisorRunId`, `activeSupervisorCommitId`, `activeSupervisorWorkflowName`.
- Watch mode now collects all `.yml`/`.yaml` files and calls `handleRunWorkflow` for each.
- `handleRunWorkflow` no longer kills existing procs — multiple can run concurrently.
- `getWorkflowsForCommit` and `getRunDetails` call `docker ps` to determine `"Running"` status.
- `stopWorkflow` uses `docker rm -f` on the current `appState.runId`.

## Next Steps

- [ ] Verify end-to-end with a real commit on a watched repo with multiple workflows.
- [ ] Consider caching `docker ps` results briefly to avoid calling it on every 3s poll cycle.
