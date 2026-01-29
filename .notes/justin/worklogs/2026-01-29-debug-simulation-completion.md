# Debugging Simulation Completion Verification 2026-01-29

## Initialized task to debug simulation completion issues
We are investigating why the simulation appears to be looping or completing prematurely without processing all items, and why the logs are unhelpful. The user reported a "completed" status despite seemingly incomplete work, and high-frequency "host.phase.dispatch" logs.

## Investigation Findings

### Loop Evidence
The logs show `host.phase.dispatch` entries occurring milliseconds apart for the same phase `materialize_moments`.
`2026-01-29T11:13:35.346Z [debug] host.phase.dispatch {"phase":"materialize_moments","phaseIdx":5}`
`2026-01-29T11:13:35.361Z [debug] host.phase.dispatch {"phase":"materialize_moments","phaseIdx":5}`

This implies that `tickSimulationRun` is being called in a tight loop. This typically happens inside `autoAdvanceSimulationRun` if the result status is `running`.

### Code Analysis (`runner.ts`)
`autoAdvanceSimulationRun` loops while `res.status === "running"`.
If the phase is `materialize_moments` and it stays in that phase, it means `onTick` is returning `running` (or `null` which defaults to `running`? No, `result?.status ?? "running"`).

### Code Analysis (`orchestration.ts`)
The standard `runStandardDocumentPolling` returns `awaiting_documents` or `advance`. It does *not* return `running`.
This suggests that `materialize_moments` might NOT be using `runStandardDocumentPolling` or runs it in a wrapper that overrides the status.

### Missing Logs
`host.phase.dispatch` only logs `{ phase, phaseIdx }`. It does not log what documents were dispatched or the result of `onTick`.

# Work Task Blueprint: Fix Simulation Completion and Stalling

## 1. Goal Description
Fix the issue where simulations mark documents as "processed" even when they fail, causing the simulation to advance prematurely and skip retries. Enhance logging to identify looping behavior and dispatch details.

## 2. User Review Required
> [!IMPORTANT]
> This change alters the "Retry" semantics. Previously, failed documents were marked processed and skipped (effectively ignored). Now, they will NOT be marked processed, keeping the run in `awaiting_documents` until they succeed (or continue failing and retrying endlessly, subject to cooldown). This is the desired "grind through" behavior.

## 3. Proposed Changes

### Core Engine
#### [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_fix-stalling-some-more/src/app/engine/runners/simulation/runner.ts)
- Update `host.phase.dispatch` log to include `runId`.
- Add logging for `onTick` result (status/phase) to trace transitions.
- Rename `host.phase.dispatch` to `host.phase.tick` for clarity.

#### [MODIFY] [orchestration.ts](file:///Users/justin/rw/worktrees/machinen_fix-stalling-some-more/src/app/engine/simulation/orchestration.ts)
- Add INFO log when dispatching documents: `host.dispatch.work` with count and sample `r2Key`.

### Phase Runners
Refactor all phase runners to **only** update `processed_phases_json` if execution was successful (no errors).

#### [MODIFY] Phase Runners (All)
- `materialize_moments`, `micro_batches`, `deterministic_linking`, `timeline_fit`, `candidate_sets`, `macro_classification`, `macro_synthesis`.
- Check `result.failed === 0` before adding to `processed_phases_json`.
- Ensure `error_json` is set on failure.

## 4. Verification Plan

### Manual Verification
1.  **Deploy** to dev/prod.
2.  **Trigger a Run** known to have failures (or inject a failure).
3.  **Observe Logs**:
    - Verify `host.phase.tick` includes `runId`.
    - Verify `host.dispatch.work` appears when items are queued.
    - Verify failed documents are retried after 30s (in dev).
    - Verify run does NOT advance to next phase while failures exist/persist.

## 5. Tasks
- [ ] Step 6: Revise Architecture Blueprint
- [ ] Step 7: Implementation
- [ ] Step 8: Verification
- [ ] Step 9: Final Review
- [ ] Step 10: Draft PR
