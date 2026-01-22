# Debug Stalled Simulation Run

// context(agent, 2026-01-22): The user reported a stalled simulation run `sim-prd` during the `micro_batches` phase. The logs show successful item processing but the run does not advance. We need to investigate potential causes like timeouts, empty queues, or logic errors in the runner.

## Plan
- [x] Investigate `micro_batches` logic
    - [x] Read `runner.ts`
    - [x] Read `adapter.ts`
- [x] Check queue status and logic
- [x] Propose and implement fix
    - [x] Create implementation plan
    - [x] Apply fix to `adapter.ts`

## Resilience & Architecture Discussion

We discussed the inherent fragility of the current "Phase Barrier" model, where a single stuck task prevents the simulation from advancing.
We considered a "Streaming" approach (pipelining phases) but decided it requires a major architectural rewrite.
Instead, we opted for a "Resilient Barrier" (Supervisor) approach.

### Decisions
- **Implement Zombie Task Detection**: The Runner triggers a Sweeper.
- **Watchdog Heartbeat**: A CRON job pokes active runs to ensure the runner wakes up even if queues are empty.
- **Entry Point Refactor**: We observed that `web/index.ts` being the phase definition file is confusing. We decided to move these to `src/app/pipelines/<phase>/index.ts` to clearly separate the Plugin Definition from the Web UI.

### Executed Steps
- [x] **Watchdog Heartbeat**: Implemented `processResiliencyHeartbeat`.
- [x] **Supervisor Interface**: Added mandatory `recoverZombies`.
- [x] **Sweepers**: Implemented `micro_batches` sweeper and no-ops for others.
- [x] **Refactor**: Moved `web/index.ts` -> `index.ts` for all phases.
