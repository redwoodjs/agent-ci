---
title: SHA Indicators in Bridge Console
date: 2026-02-15 00:48
author: peterp
---

# SHA Indicators in Bridge Console

## Summary

Implemented UI indicators in the Bridge Console to display the target SHA for both local and GitHub-triggered jobs. This involved standardizing the data persistence layer in the Bridge API and updating the Console UI to be SHA-aware.

## The Problem

While `oa run <sha>` was functional in the runner, the Bridge Console (UI) provided no feedback on which SHA a local run was targeting. Additionally, the Console UI was misconfigured to use a different KV binding and naming convention than the Bridge API, preventing local jobs from appearing in the list at all.

## Investigation & Timeline

- **Initial State:**
  - `runner` was sending `headSha` to the Bridge.
  - `bridge/src/api/routes.ts` was queuing local jobs but not persisting them for the UI.
  - `bridge/src/app/pages/admin/jobs.tsx` was using a non-existent `env.JOBS` binding.
- **Attempts:**
  - Identified that `handleLocalJob` needed to mirror the storage logic of GitHub webhooks.
  - DISCOVERED that the UI logic relied on a `webhooks:recent` key that wasn't being maintained by the API.
  - STANDARDZED on the `webhook@<id>` prefix for all job records in the `MACHINEN_BRIDGE_JOBS` KV.

## Discovery & Key Findings

- The Bridge API was storing active job queues for runners separately from the historical records used by the UI.
- Unifying the storage format for `local_sync` and `workflow_job` events allows the Console to treat them as first-class citizens in a single view.

## Resolution

- **Bridge API:** Updated `handleWebhook` and `handleLocalJob` to maintain a `webhooks:recent` list and persist job metadata (including `headSha`).
- **Console UI:** Refactored `JobsPage` to use the correct `MACHINEN_BRIDGE_JOBS` binding, added columns for "Type" (Local vs. GitHub) and "SHA", and improved formatting.

## Next Steps

- [ ] Add support for "re-running" a local job directly from the Console UI.
- [ ] Implement short-SHA to branch name resolution in the UI for better context.
