# 2026-01-19-simulation-stabilization

## Reconstructing the history of the "queue refactor mess"

I went through the commits to understand why the current state is broken and how we got here.

### Chronology

- **`295f6a4` (Jan 18)**: **Last Stable Point.**
  - Simulation has granular logging, concurrency locking (`busy_running`), and balanced sampling.
  - Runners are present in `src/app/pipelines/<phase>/engine/simulation/runner.ts`.
  - Everything is functional and matches the Jan 18 work log.

- **`88bf979` (Jan 19, 11:55 AM)**: **Introduction of Queue-based Strategy.**
  - Initial attempt to "always use queues" for simulation.
  - Added `simulation-worker.ts` to handle jobs.
  - Runners were updated to support deferral/enqueuing.
  - All phase runners were still intact.

- **`585c932` (Jan 19, 1:18 PM)**: **The "Great Deletion".**
  - **Mistake:** Several critical simulation runners were deleted (`ingest_diff`, `macro_classification`, `macro_synthesis`).
  - **Mistake:** All 10 simulation test files were deleted (`tests/simulation/*.test.mjs`).
  - **Mistake:** `replay-run-log-text.tsx` was deleted, breaking the UI build.
  - The `micro_batches` runner was refactored but introduced an infinite loop risk (re-enqueuing on every advance).

- **`f143e2d` (Jan 19, 1:36 PM)**: **Revert of `585c932`.**
  - Attempted to undo the damage and restore the deleted files.

- **`4a0e9ff` (Jan 19, 1:38 PM)**: **Re-application of the "Mess" (Current HEAD).**
  - Re-introduced the deletions and the broken queue logic.
  - Claims to "fix infinite dispatch loop in micro_batches", but the broader state is still broken (missing files, broken build).

### Current State

- The repo is **not buildable** (missing `replay-run-log-text.tsx`).
- The simulation registry refers to **deleted runners** (`ingest_diff`, `macro_classification`, `macro_synthesis`).
- Nearly all **simulation tests are gone**.
- The "always queue" logic in `micro_batches` still looks prone to re-dispatch loops if one isn't careful.

## Plan for stabilization

My goal is to restore the stable behavior while preserving the "always queue" intent where it was actually working.

1.  **Restore missing files**: Bring back the deleted runners, tests, and UI components from the last stable point or the revert commit.
2.  **Fix the build**: Resolve the broken import in `replay-run-log-page.tsx`.
3.  **Sanitize the queue logic**: Ensure the "always queue" strategy is implemented safely across all phases, with clear "phase completion" checks to prevent re-dispatch loops.
4.  **Verify with tests**: Re-run the simulation test suite once restored to ensure the hardened semantics are preserved.
5.  **Re-align work log**: Ensure the 2026-01-18 work log reflects the actual final state once we are back on track.

## Critical Constraints for Stabilization

- **Strict Asynchronicity**: No synchronous processing for simulation or live indexing. Everything must walk through queues.
- **Serverless Timeouts**: Cloudflare Workers (and similar environments) have a strict ~3s execution limit for compute. We cannot have long-running loops or complex computation in a single request.
- **Aggressive Chunking**: Break down work into the smallest possible units (documents, batches, moments) and dispatch them to the queue.
- **Replay/Simulation Polling**: The host runner should primarily dispatch to queues and return. The UI/tests are responsible for polling status to observe progression.

## Implementation Plan (Revised)

1.  **Restore and Adapt Runners**: Bring back `ingest_diff`, `macro_classification`, and `macro_synthesis` runners, but ensure they immediately dispatch to the `ENGINE_INDEXING_QUEUE` instead of performing work inline.
2.  **Fix Dispatch Loops**: Ensure `micro_batches` (and other phases) have clear termination conditions and don't re-enqueue the same work indefinitely.
3.  **Restore Tests**: Bring back `tests/simulation/*.test.mjs` and ensure they work with the polling-based async flow.
4.  **UI Build Fix**: Restore `replay-run-log-text.tsx` and ensure `LogViewer` is functioning correctly.

## Next steps

- [/] Restore and Adapt `ingest_diff`, `macro_classification`, and `macro_synthesis` runners.
- [ ] Restore `tests/simulation/*.test.mjs`.
- [ ] Restore `replay-run-log-text.tsx`.
- [ ] Verify build passes.
- [ ] Fix the infinite dispatch loop in `micro_batches`.
- [ ] Final verification of "Always Queue" strategy across all phases.
