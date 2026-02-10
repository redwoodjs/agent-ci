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
- [x] Add migration `015_add_attempts_to_documents` <!-- id: 20 -->
- [x] Implement `COALESCE` fix in `runner.ts` <!-- id: 21 -->
- [x] Implement retry limit in `recoverPhaseZombies` <!-- id: 22 -->
- [x] Verify fix by forcing a zombie scenario <!-- id: 23 -->

## Implemented Resiliency Fixes

We have completed the implementation of the simulation resiliency fixes:
1.  **Resolved the "Ghost Document" bug**: Updated `runner.ts` and `simulation-worker.ts` to use `COALESCE` for JSON column queries and updates.
2.  **Implemented Document Ditching**: Added `attempts_json` tracking and logic in `recoverPhaseZombies` to skip documents after 3 failed attempts.
3.  **Updated Architecture Blueprint**: Formally documented the resiliency requirements in `docs/blueprints/runtime-architecture.md`.
4.  **Added Migration**: Created `015_add_attempts_to_documents` to support the new tracking column.

The system will now correctly identify stalled documents and prevent infinite loops by eventually "ditching" high-failure documents and advancing the simulation.

## PR Draft: Implement Simulation Resiliency and Zombie Ditching

### Context
Our simulation engine processes large volumes of documents through a unified 8-phase pipeline. Maintaining throughput and reliability during these runs is critical for generating accurate knowledge graph reconstructions without human intervention.

### Problem
We identified a total stall in the simulation run during the `micro_batches` phase. This was caused by two primary issues:
1.  **Ghost Documents**: Due to the way SQLite's `json_insert` behaves with `NULL` inputs, documents with uninitialized state became invisible to our recovery queries. They were neither "processed" nor "dispatched" in a way the system could detect, leaving them in a permanent limbo.
2.  **Infinite Retries**: The system lacked any mechanism to abandon documents that consistently failed (e.g., due to crashing workers or persistent timeouts). This caused the runner to stay in the same phase indefinitely, waiting for a completion that would never happen.

### Solution
We introduced a document-level resiliency layer to ensure simulation runs can advance even in the presence of problematic data.
- **Visibility Protection**: We updated all JSON path queries and updates to use `COALESCE` patterns, ensuring that newly discovered documents are always visible to the orchestrator regardless of their initial state.
- **Zombie Ditcher**: We added an `attempts_json` column to track retries per phase. If a document fails to progress after 3 attempts, the system now automatically "ditches" it—marking it as skipped in the phase history and logging a warning event.
- **Eventual Advancement**: 
## Speccing Engine Implementation & Discovery Investigation
We transitioned into implementing and verifying the **Speccing Engine** to replay narratives from the simulation runs.

### Technical Findings
1. **Discovery Stall**: `POST /api/subjects/search` returns 0 results even with `DEBUG_SKIP_FILTER: true`. Although Vectorize reports 16,383 vectors in `moment-index-v8`, they likely lack the `momentGraphNamespace` metadata for our simulation run because the metadata indices were created *after* the initial materialization.
2. **Durable Object Fallback**: We successfully implemented and verified a fallback mechanism in `subjects.ts`. If semantic search fails, the engine can now query the Durable Object directly to find subjects if a namespace is provided.
3. **Connectivity Stabilization**: We standardized all local verification on `127.0.0.1:5174` to resolve intermittent "Connection Refused" issues caused by IPv6/localhost resolution conflicts.