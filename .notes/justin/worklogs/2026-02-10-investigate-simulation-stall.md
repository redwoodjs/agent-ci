# Worklog: 2026-02-10 - Investigating Simulation Stall

## Investigating the log failures
- We started by reading the `runtime-architecture.md` blueprint to understand the unified pipeline.
- We are analyzing `sim.log` (pointer provided: `/Users/justin/rw/worktrees/machinen_unstick/.tmp/sim.log`).
- The user reports the run stopped at `micro_batches` phase.
- Evidence shows `processed: 185, total: 204` at `2026-02-09T20:01:12`.
- The last successfully processed document in `micro_batches` appears to have been much earlier in the day (`07:15`).
- We found 19 "Ghost Documents" that are likely stuck in limbo.

## The Ghost Document Theory
- We identified a critical bug in `src/app/engine/runners/simulation/runner.ts` regarding JSON column updates.
- When dispatching a phase, we use: `sql'json_insert(dispatched_phases_json, '$[#]', ${phase})'`.
- In SQLite/D1, `json_insert(NULL, ...)` returns `NULL`.
- Since `dispatched_phases_json` starts as `NULL` for new documents, the update results in the column remaining `NULL`.
- This causes a "Limbo" state:
    1. **Dispatcher skips them**: `where json_extract(dispatched_phases_json, '$') not like '%micro_batches%'` fails because `NULL not like ...` is `UNKNOWN`.
    2. **Zombie recovery skips them**: `where json_extract(dispatched_phases_json, '$') like '%micro_batches%'` fails for the same reason.
- The documents were sent to the queue once (logs show `engine.context-initialized` for some of them), but they likely crashed or timed out, and the runner can no longer "see" them to retry.

## Observation: Missing Ditching Logic
- We inspected `src/app/engine/simulation/types.ts` and confirmed that `simulation_run_documents` has no columns for `retry_count`, `attempts`, or `max_attempts`.
- We inspected `recoverPhaseZombies` in `runner.ts` and confirmed it simply re-dispatches stuck documents to the queue without any limit or "give up" logic.
- Currently, if a document stays in "dispatched" but never reaches "processed," the simulation run will remain in `awaiting_documents` indefinitely.
- The system has no way to "ditch" a document that repeatedly fails or times out.

## Draft Plan (RFC): Simulation Resiliency Fix
We propose fixing the "Ghost Document" bug and implementing a "Ditching" mechanism to prevent infinite stalls.

### 2000ft View
We will ensure that all documents are properly tracked during dispatch and that stuck "zombies" are eventually abandoned after a set number of retries. This allows the simulation to proceed even if specific documents are unprocessable (e.g., due to size limits or unhandled edge cases).

### Database Changes
#### [MODIFY] [simulation_run_documents](file:///Users/justin/rw/worktrees/machinen_unstick/src/app/engine/simulation/migrations.ts)
- Add `attempts_json` column (`text`, nullable) to store a JSON map of `{ [phaseName]: attemptCount }`.

### Behavior Spec
- **GIVEN** a document in phase `micro_batches` that has crashed/timed out.
- **WHEN** `recoverPhaseZombies` runs.
- **THEN** it should increment the attempt count for `micro_batches` for that document.
- **AND IF** the attempt count exceeds `3` (max attempts).
- **THEN** it should mark the document as "failed" for that phase (add to `processed_phases_json` with a prefix or use a new `failed_phases_json` column) and allow the run to advance.

### Implementation Breakdown
#### [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_unstick/src/app/engine/runners/simulation/runner.ts)
- Use `COALESCE(dispatched_phases_json, '[]')` when updating or checking dispatched phases to avoid the `NULL` pitfall.
- Update `recoverPhaseZombies` to pull `attempts_json`, increment, and optionally "ditch" the document.

#### [MODIFY] [simulation-worker.ts](file:///Users/justin/rw/worktrees/machinen_unstick/src/app/engine/services/simulation-worker.ts)
- Ensure `dispatched_phases_json` is initialized to `'[]'` on first insert.

### Tasks
- [ ] Add migration `015_add_attempts_to_documents` <!-- id: 20 -->
- [ ] Implement `COALESCE` fix in `runner.ts` <!-- id: 21 -->
- [ ] Implement retry limit in `recoverPhaseZombies` <!-- id: 22 -->
- [ ] Verify fix by forcing a zombie scenario <!-- id: 23 -->
