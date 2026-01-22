# Debug Stalled Simulation Run

// context(agent, 2026-01-22): The user reported a stalled simulation run `sim-prd` during the `micro_batches` phase. The logs show successful item processing but the run does not advance. We need to investigate potential causes like timeouts, empty queues, or logic errors in the runner.

## Plan
- [/] Investigate `micro_batches` logic
    - [x] Read `runner.ts`
    - [x] Read `adapter.ts`
- [ ] Check queue status and logic
- [x] Propose and implement fix
    - [x] Create implementation plan
    - [x] Apply fix to `adapter.ts`

## Resilience & Architecture Discussion

// context(justinvdm, 2026-01-22): We discussed the inherent fragility of the current "Phase Barrier" model, where a single stuck task prevents the simulation from advancing.
// We considered a "Streaming" approach (pipelining phases) but decided it requires a major architectural rewrite (e.g. tracking per-document phase progress).
// Instead, we are opting for a "Resilient Barrier" approach: hardening the current system to ensure "Silent Failures" (timeouts, OOMs) are detected and resolved to a terminal state ("Failed"), preserving the barrier invariant (Processed Count == Total Count).

### Decisions
- **Reject Streaming (for now)**: Too high complexity/effort for current needs.
- **Implement Zombie Task Detection**: The Runner will act as a "Supervisor". If a batch remains `enqueued` for > 10 minutes (implied timeout), the Runner explicitly fails it.
- **Goal**: Ensure the "Done" condition (`enqueued == 0`) is always reachable.

## Revised Plan
- [ ] Implement "Zombie Sweeper" in `micro_batches` runner
    - [ ] Detect batches stuck in `enqueued` state for > 10m
    - [ ] Mark as `failed` with "Timeout" error
- [ ] Verify using manual test case (simulated stall)
