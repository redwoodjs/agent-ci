# Investigate Simulation Stalling and Caching Issues 2026-01-29

## Initialized task to investigate simulation stalling and caching logic
We are investigating why the simulation stalls, especially in the "run all" case. The user reports unhelpful logs and suspects that caching logic might be broken after recent resiliency changes. We will look into `orchestration.ts` and phase runners to ensure that unchanged documents are handled correctly and that logging is verbose enough to diagnose stalling.

## Investigation Findings

### 1. Polling Filter Logic Error
In [orchestration.ts](src/app/engine/simulation/orchestration.ts), the `runStandardDocumentPolling` factory uses `where("changed", "=", 1)` in both its document selection and its completion check.
- **Problem**: Documents marked as `changed = 0` (unchanged since last R2 check) are COMPLETELY ignored.
- **Impact**: If a run is a re-run or uses incremental logic, unchanged documents are never processed by phases like `materialize_moments`. This means their results are never populated in the run-specific output tables. Later phases (like `timeline_fit`) will see zero documents/moments for these items, leading to incomplete simulation runs.
- **Stalling**: If a phase depends on all documents being processed, but `changed=0` docs are skipped and never marked as `processed`, the phase might advance prematurely OR fail to find expected data.

### 2. Spammy Logs
The `host.phase.dispatch` logs in [runner.ts](src/app/engine/runners/simulation/runner.ts) occur at the start of every supervisor tick. Because the queue workers trigger a `simulation-advance` tick after EVERY document processed, thousands of documents result in thousands of ticks. If these ticks happen while the state is `awaiting_documents`, they log but do nothing, creating the "spam" reported by the user.

### 3. Loop Evidence
The 2ms interval between logs indicates that `autoAdvanceSimulationRun` is likely looping. This only happens if `tickSimulationRun` returns `status: "running"`. We need to verify why a phase would return `running` instead of `awaiting_documents` when it has no more work to dispatch but is not yet complete.

## Decisions & Planning

- **Modify `runStandardDocumentPolling`**: Remove the `changed = 1` filter. Every document that is NOT processed for the current phase should be considered pollable. Individual handlers (`onExecute`) should decide whether they can skip work based on caching.
- **Enhance Logging**:
  - Rename `host.phase.dispatch` to `host.phase.tick`.
  - Add `runId` to the tick log.
  - In `orchestration.ts`, add info logs when dispatching work, including the count and sample keys.
  - Log the result of `onTick` (status and phase) to see why it stays in `running`.
- **Refine Completion Check**: Ensure `allProcessed` considers ALL documents in the run, regardless of the `changed` flag, to ensure the run is truly complete.

# Work Task Blueprint: Robust Simulation Polling and Verbose Logging

## 1. Context
The simulation engine stalls or provides incomplete results when documents are marked as unchanged (`changed = 0`). This is due to an over-aggressive optimization in the centralized polling logic. Additionally, the supervisor logs are too terse to identify looping or stalling causes.

## 2. Breakdown of Planned Changes

### Core Simulation Engine
* [MODIFY] `orchestration.ts`:
  - Remove `where("changed", "=", 1)` from `pollableDocs` query.
  - Remove `where("changed", "=", 1)` from `totalDocs` completion query.
  - Add `addSimulationRunEvent` (kind: `host.dispatch.work`) when enqueuing documents.
* [MODIFY] `runner.ts`:
  - Rename `host.phase.dispatch` to `host.phase.tick`.
  - Include `runId` in the tick log.
  - Add `host.phase.transition` log reflecting the result of `onTick`.

### Phase Runners
* [INVESTIGATE] Each phase's `onExecute` to ensure it handles "skipped" work correctly.
  - Most phases ALREADY check for existence of outputs or cache. By letting them run for `changed=0` docs, we ensure they mark themselves as `processed` and populate run-specific tables.

## 3. Directory & File Structure
```text
src/app/
├── engine/simulation/
│   ├── [MODIFY] orchestration.ts
│   └── [MODIFY] runner.ts
└── pipelines/
    └── [MODIFY] (Verify onExecute in all phase runners)
```

## 4. Types & Data Structures (No Changes)

## 5. Invariants & Constraints
- **Invariant**: A simulation phase is only complete when ALL documents in `simulation_run_documents` for that run have the phase in their `processed_phases_json`.
- **Invariant**: Supervisor logging must be descriptive enough to identify the specific work unit being dispatched.

## 6. System Flow (Snapshot Diff)
**Previous Flow**: `onTick` ignores `changed=0` docs -> Phase advances with partial data.
**New Flow**: `onTick` polls all unprocessed docs -> Handlers run for everything -> `changed=0` docs use cache/skip fast but mark as `processed` -> Phase only advances when everything is truly done.

## 7. Suggested Verification (Manual)
- Run a simulation locally with some documents already processed (causing `changed=0`).
- Verify that the logs show `host.dispatch.work` for ALL documents.
- Verify that the simulation completes and `simulation_run_materialized_moments` is fully populated.

## 8. Tasks
- [x] Task 1: Update Polling Logic in `orchestration.ts`
- [x] Task 2: Enhance Supervisor Logging in `runner.ts`
- [x] Task 3: Add Dispatch Logging to `orchestration.ts`
- [x] Task 4: Verify `onExecute` behavior in all phase runners.
- [x] Task 5: Implement and verify deep cache disabling across all layers.

# PR: Global Simulation Cache Bypass and Artifact Completeness

## Problem
Despite improvements to supervisor orchestration, simulation runs continued to show data inconsistencies, such as "Untitled" moments with missing summaries and stale processing indicators. These issues were caused by persistent caching at multiple layers—ETag checks in ingestion, micro-batch lookups in processing adapters, and Moment ID reuse in the core engine—which incorrectly skipped the re-computation of artifacts for fresh simulation runs.

## Solution
We have introduced a global mechanism to bypass caching across the entire simulation pipeline, ensuring that every run produces a complete and verified set of results.

The solution consists of several key components:

1.  **Global Environment Variable**: Introduced `SIMULATION_DISABLE_CACHING` to govern the processing flow. When enabled, it forces a "clean slate" execution by bypassing all major caching layers.
2.  **Forced Re-computation**: Updated the ingestion, micro-batching, and synthesis phases to ignore previous ETags and content hashes. This ensures that every document is re-evaluated and every LLM-driven artifact is regenerated.
3.  **Moment ID Isolation**: Modified the core engine to prevent the reuse of existing Moment IDs based on content hashes. This ensures that new simulation runs generate fresh records, preventing the "ghosting" of incomplete titles or summaries from previous failed attempts.
4.  **Complete Traceability**: By forcing a clean run, we guarantee that the simulation artifact tables are fully populated with fresh data, removing any possibility of "silent skips" due to legacy cache state.

This toggle ensures that simulations produce reliable, traceable evidence for every document in a run, and can be adjusted as needed for performance or debugging.

## Summary of Changes

### Configuration
- [MODIFY] `wrangler.jsonc`: Added `SIMULATION_DISABLE_CACHING: "1"` to global vars.
- [MODIFY] `worker-configuration.d.ts`: Added `SIMULATION_DISABLE_CACHING` to `Env` and `ProcessEnv` types.

### Orchestration & Polling
- [MODIFY] `src/app/engine/simulation/orchestration.ts`: Removed `changed = 1` filtering from polling and completion logic. Added `host.dispatch.work` event.

### Phase Adapters & Runners
- [MODIFY] `src/app/pipelines/ingest_diff/engine/simulation/runner.ts`: Bypasses ETag lookup when caching is disabled, forcing `changed: true`.
- [MODIFY] `src/app/pipelines/micro_batches/engine/simulation/adapter.ts`: Explicitly bypasses `loadMicroBatchCache` when caching is disabled (fixes reported log issue).
- [MODIFY] `src/app/pipelines/macro_synthesis/engine/simulation/adapter.ts`: Bypasses `loadPreviousMicroStreamHash` when caching is disabled.

### Core Engine
- [MODIFY] `src/app/engine/engine.ts`:
  - Bypasses micro-moment cache lookup in `loadMicroBatchCache` port.
  - Bypasses `findMomentByMicroPathsHash` lookup when re-materializing moments, ensuring fresh Moment IDs and re-computation of parents/importance.

### Supervisor Auditability
- [MODIFY] `src/app/engine/runners/simulation/runner.ts`: Renamed supervisor events to `host.phase.tick` and added `host.phase.transition` for explicit state tracking.

# PR: Global Simulation Cache Bypass and Artifact Completeness

## Problem
Despite improvements to supervisor orchestration, simulation runs continued to show data inconsistencies, such as "Untitled" moments with missing summaries and stale processing indicators. These issues were caused by persistent caching at multiple layers—ETag checks in ingestion, micro-batch lookups in processing adapters, and Moment ID reuse in the core engine—which incorrectly skipped the re-computation of artifacts for fresh simulation runs.

## Solution
We have introduced a global mechanism to bypass caching across the entire simulation pipeline, ensuring that every run produces a complete and verified set of results.

The solution consists of several key components:

1.  **Global Environment Variable**: Introduced `SIMULATION_DISABLE_CACHING` to govern the processing flow. When enabled, it forces a "clean slate" execution by bypassing all major caching layers.
2.  **Forced Re-computation**: Updated the ingestion, micro-batching, and synthesis phases to ignore previous ETags and content hashes. This ensures that every document is re-evaluated and every LLM-driven artifact is regenerated.
3.  **Moment ID Isolation**: Modified the core engine to prevent the reuse of existing Moment IDs based on content hashes. This ensures that new simulation runs generate fresh records, preventing the "ghosting" of incomplete titles or summaries from previous failed attempts.
4.  **Complete Traceability**: By forcing a clean run, we guarantee that the simulation artifact tables are fully populated with fresh data, removing any possibility of "silent skips" due to legacy cache state.

This toggle ensures that simulations produce reliable, traceable evidence for every document in a run, and can be adjusted as needed for performance or debugging.
