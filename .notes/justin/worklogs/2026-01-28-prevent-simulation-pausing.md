# Prevent Simulation Pausing on Error 2026-01-28

## Initialized task to prevent simulation from pausing on errors
We are investigating why the simulation pauses when encountering errors instead of continuing with other documents/chunks. The goal is to ensure that failures in specific entities do not block the entire simulation pipeline. We want to implement or leverage retries (recover zombies) and ensure invariants such that errors are non-blocking.

# Work Task Blueprint: Granular Event-Based Retries

## 1. Context
The simulation engine currently stalls or skips work because it treats errors as permanent blocking states. We need to move to a model where:
- **Runner Crashes** (Host-level) do not skip phases; they log an event and let the heartbeat retry the *polling* for the remaining work.
- **Document Failures** are recorded as simulation events (history) and retried after a cooldown period.
- **Polling** becomes the primary progress driver, using time-based cooldowns to manage retries rather than destructive state clearing.

## 2. Breakdown of Planned Changes

### Core Simulation Engine
* [MODIFY] `advanceSimulationRunPhaseNoop` (`runner.ts`):
  - In the `catch` block for `continueOnError`, log a `phase.host_crash` event and return `running` at the **current phase index**. This ensures the next heartbeat continues polling the same phase for unfinished work.
* [MODIFY] `recoverZombiesForPhase` (`resiliency.ts`):
  - Keep its focus on resetting "stuck" documents (those in `dispatched` but not `processed`).
  - Ensure it updates `updated_at` to trigger a new poll attempt.

### Granular Phase Runners (e.g., `micro_batches`, `macro_synthesis`)
* [MODIFY] Polling Query:
  - Remove `where error_json is null`.
  - Add a **Retry Cooldown**: Filter for documents where `updated_at < (now - 10 minutes)` OR `updated_at` is very old.
  - This ensures documents that failed are eventually picked up again without spinning in an infinite loop.
* [MODIFY] Error Handling:
  - When an entity (doc/chunk) fails, record the error via `addSimulationRunEvent`.
  - Update the document row's `updated_at` and `error_json` (as a cache), but **do not** add the phase to `processed_phases_json`.

## 3. Directory & File Structure
```text
src/app/
├── engine/
│   ├── runners/
│   │   └── [MODIFY] simulation/runner.ts
│   └── simulation/
│       └── [MODIFY] resiliency.ts
└── pipelines/
    ├── [MODIFY] micro_batches/engine/simulation/runner.ts
    ├── [MODIFY] macro_synthesis/engine/simulation/runner.ts
    └── (Other phase runners updated iteratively)
```

## 4. Types & Data Structures
We utilize the existing `SimulationRunEvent` table for persistent error history ("for the sim"). No schema changes.

## 5. Invariants & Constraints
- **Invariant**: Host-level crashes MUST NOT skip a phase or set `paused_on_error` if `continueOnError` is active.
- **Invariant**: Document failure history MUST be preserved in the event log.
- **Invariant**: Retries MUST be granular (at the document or batch level) and governed by a temporal cooldown.

## 6. System Flow (Snapshot Diff)
**Previous Flow**: 1. Host crashes -> Phase skips. 2. Doc fails -> `error_json` blocks re-polling.
**New Flow**: 1. Host crashes -> Log event -> Heartbeat retries same phase polling. 2. Doc fails -> Log event -> Runner re-polls doc after 10m cooldown.

## 7. Suggested Verification (Manual)
- **Host Crash**: Induce a crash in `advanceSimulationRunPhaseNoop`. Verify the run remains `running` at the same phase.
- **Granular Retry**: Force a doc to fail. Verify it is re-attempted after 10 minutes (or manual time shift).
- **History Check**: Verify all failures are logged as events and not just overwritten in the doc row.

## 8. Tasks
- [ ] Step 6: Revise Architecture Blueprint
- [ ] Step 7: Implementation
- [ ] Step 8: Verification
- [ ] Step 9: Final Review
- [ ] Step 10: Draft PR


## Investigation Findings: Sticky Pauses and Lack of Retries
We have identified several architectural flaws that cause the simulation to pause on errors:

1. **Sticky `paused_on_error`**: When the host runner catches an exception, it sets the run status to `paused_on_error`. This state is "sticky" because the host runner's guard check returns early for anything other than `running` or `awaiting_documents`, preventing the watchdog from ever retrying the run automatically.

2. **Aggressive Phase Skipping**: The `continueOnError` logic in `runner.ts` advances the entire run to the next phase upon a crash. This is counter-productive if the crash was transient or specific to a small set of documents, as it effectively abandons all remaining work in the current phase.

3. **Ignore-on-Error Pattern**: Phase runners (like `micro_batches` and `macro_synthesis`) explicitly filter out documents that have an `error_json`. Once a document fails once, it is never attempted again by the runner, even if the underlying issue is resolved or was transient.

4. **Limited Zombie Recovery**: The current `recoverZombiesForPhase` only resets documents that are "stuck" (dispatched but not finished). It does not have a mechanism to reset documents that have officially failed (`error_json` is set).

## Decision: Implement Non-Blocking Error Handling and Retry Logic
We decided to:
- Make `paused_on_error` non-blocking for the watchdog if a retry is appropriate.
- Modify the host runner to avoid skipping phases on transient crashes.
- Introduce a retry mechanism for failed documents in the resiliency sweeper.
- Update the Simulation Engine Blueprint to reflect the "Errors do not block" invariant.

## Decisions & Planning
The strategy above prioritizes eventual consistency and progress over strict sequential success. By allowing the host to stay in `running` status and having the sweeper handle both "stuck" (zombie) and "failed" documents, we ensure that the simulation can grind through noisy datasets without human intervention.


