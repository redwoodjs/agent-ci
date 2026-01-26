# Investigate Stalled Simulation Run 2026-01-27

## Started investigation into stalled simulation run
###
The user reported that run `053ffe62-3a48-4f53-8422-0f926646d0e7` seems to have stopped midway through.
The UI shows only 3/50 documents processed for later phases like `materialize_moments` and `deterministic_linking`.

### Plan
<!-- Work Task Blueprint -->
#### Directory & File Structure
No code changes planned yet. This is an investigation.

#### Types & Data Structures
No type changes planned.

#### Invariants & Constraints
We expect the simulation to process all 50 documents or report an error.

#### System Flow (Snapshot Diff)
We are investigating the flow between `macro_classification` and `materialize_moments`.

#### Natural Language Context
Rationale: The simulation stalled without clear error in the UI. We need to find the bottleneck or failure point in the logs.

#### Suggested Verification (Manual)
Check the logs for runId `053ffe62-3a48-4f53-8422-0f926646d0e7`.

### Tasks
- [x] Investigate stalled run in logs
    - [x] Search for runId `053ffe62-3a48-4f53-8422-0f926646d0e7` in `/tmp/sim.log`
    - [x] Identify where the run stopped and what was the last activity
    - [x] Check for any errors or timeouts
- [ ] Implement systemic fix for JSON corruption and progress leak [/]
- [ ] Add R2 fetch retry logic [ ]
- [ ] Verify fix with a fresh simulation run [ ]

## Identified root cause of simulation stall and data corruption
###
We have identified two major issues causing the simulation to fail silently:
1. **Data Corruption**: `processed_phases_json` is being corrupted because it's treated as a string and then spread into individual characters in the runner's state update logic.
2. **False Progress**: Phase runners incorrectly mark documents as "finished" even if they fail during processing in the adapter. This allows the simulation host to advance all the way to "completed" even when only a fraction of the documents actually succeeded.

The "Unspecified error (0)" reported for 47 documents likely stems from transient R2 fetch failures in the local `wrangler` environment when handling high concurrency.
## Final Plan after Feedback
We decided to:
1.  **Fix state corruption (`i,n,g,e,s,t...`)**: The root cause is `processed_phases_json` being typed as `string | null` in `SimulationRunDocumentsTable`. This causes Kysely to treat it as a string, leading to character spreading when using `[...currentPhases, phase]`. We will change these types to `string[] | null`.
2.  **Ensure run continuity**: We want simulations to continue even if some documents fail. We will update runners to:
    - Capture errors from adapters.
    - Record document-level errors in `simulation_run_documents.error_json`.
    - Append the phase to `processed_phases_json` even on failure so the phase runner can advance to the next phase.
3.  **Adhere to Standards**: Remove manual `JSON.parse` blocks since `rwsdk/db` handles this automatically for array-typed columns.

### Updated Plan
<!-- Work Task Blueprint -->
#### Directory & File Structure
```text
src/app/
├── engine/
│   ├── [MODIFY] simulation/types.ts
│   └── [MODIFY] indexing/pluginPipeline.ts
└── pipelines/
    ├── [MODIFY] materialize_moments/engine/simulation/runner.ts
    ├── [MODIFY] macro_classification/engine/simulation/runner.ts
    ├── [MODIFY] deterministic_linking/engine/simulation/runner.ts
    ├── [MODIFY] candidate_sets/engine/simulation/runner.ts
    └── [MODIFY] timeline_fit/engine/simulation/runner.ts
```

#### Types & Data Structures
- **SimulationRunDocumentsTable**:
```typescript
type SimulationRunDocumentsTable = {
  // ...
  dispatched_phases_json: string[] | null; // Changed from string | null
  processed_phases_json: string[] | null;  // Changed from string | null
};
```

#### Invariants & Constraints
- **Invariant**: `processed_phases_json` must be typed as an array to trigger automatic JSON serialization in `rwsdk/db`.
- **Invariant**: A document is considered "done" for a phase if it is present in `processed_phases_json`, regardless of whether `error_json` is set.

#### System Flow (Snapshot Diff)
- **Previous**: `adapter() -> if success { update_phase } -> else { throw error (stalls run) }`.
- **New**: `adapter() -> capture failures -> update_doc_errors -> update_phase (unconditional) -> run continues`.

#### Natural Language Context
Rationale: The current system allows simulations to "succeed" while silently failing document processing. By coupling the `processed_phases_json` update to successful adapter execution, we ensure the `awaiting_documents` state correctly reflects actual progress.

#### Suggested Verification (Manual)
1. Restart run `053ffe62-3a48-4f53-8422-0f926646d0e7`.
2. Verify in SQLite that `processed_phases_json` is a valid JSON array string.

## Implemented fixes for JSON corruption and simulation continuity
We have completed the implementation of the plan:
1.  **Fixed `types.ts`**: Updated `SimulationRunDocumentsTable` to use `string[] | null` for phase columns. This ensures `rwsdk/db` handles them as arrays, fixing the character-spreading corruption.
2.  **Updated `pluginPipeline.ts`**: Added a 3x retry loop with exponential backoff for R2 fetches in `prepareDocumentForR2Key`.
3.  **Updated all Phase Runners**:
    - `materialize_moments`, `macro_classification`, `deterministic_linking`, `candidate_sets`, `timeline_fit`, `macro_synthesis`, `micro_batches`.
    - Each runner now captures adapter failures, records them in `error_json`, and unconditionally advances `processed_phases_json` to ensure the simulation doesn't stall on document errors.
    - Removed character-spreading risks by using array-safe updates.

## Identified heartbeat and zombie recovery failure points
###
We have identified why the heartbeat failed to pick up the stalled run:

1. **Heartbeat Early Return**: In `advanceSimulationRunPhaseNoop`, we return early if the run status is `busy_running`. If the worker hosting the supervisor task times out or crashes, the status remains `busy_running`, and the heartbeat (enqueued as `simulation-advance`) does nothing.
2. **Missing Zombie Recovery**: All phase runners (including `timeline_fit`) have an empty `recoverZombies` implementation. Even if the supervisor task starts, it doesn't know how to find and re-enqueue documents that were dispatched but never finished (likely due to worker timeouts).
3. **Worker Timeouts**: Individual document workers (e.g., for `timeline_fit`) can time out (Cloudflare's 30s limit). When this happens, they never reach the "unconditional advancement" logic, leaving the document in a dispatched but unprocessed state.

### Evidence
- **Log analysis**: The run stopped at 17/50, and the last events were `debug.run_context`.
- **Code review**: `src/app/engine/runners/simulation/runner.ts:37-39` shows early return for `busy_running`.
- **Code review**: `src/app/pipelines/timeline_fit/index.ts:16` shows empty `recoverZombies`.
- **Code review**: `src/app/pipelines/timeline_fit/engine/simulation/runner.ts:44-98` shows that we ONLY dispatch documents that are NOT in `dispatched_phases_json`. There is no logic to re-dispatch documents that have been `pending` for too long.

### Proposed Fix
1. **Heartbeat Resiliency**: Update `advanceSimulationRunPhaseNoop` to proceed even if `busy_running` if `updated_at` is more than X minutes old (e.g., 5 minutes).
2. **Zombie Recovery Implementation**: Implement `recoverZombies` for all relevant phases. This function should look for documents in `simulation_run_documents` that are dispatched but not processed, and where `updated_at` is too old, and reset their `dispatched_phases_json`.
3. **Supervisor Heartbeat**: Optionally, let `processSimulationJob` (for `simulation-document`) update the run's `updated_at` to show it's still alive. Wait, `simulation_run_documents` has its own `updated_at`.

We will focus on implementing `recoverZombies` in the pipelines and fixing the `busy_running` lock logic.
