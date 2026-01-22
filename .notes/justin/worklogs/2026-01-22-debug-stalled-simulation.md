# Debug Stalled Simulation Run

The user reported a stalled simulation run `sim-prd` during the `micro_batches` phase. The logs show successful item processing but the run does not advance. We need to investigate potential causes like timeouts, empty queues, or logic errors in the runner.

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

## PR Draft

# Implement Resilient Runner Supervisor and Watchdog Heartbeat

### Problem & Context
The Simulation Pipeline was susceptible to infinite stalls when tasks failed silently (e.g., Worker OOM or Time Limit Exceeded). Because the runner relied on an `enqueued == 0` terminal condition, any "lost" task in the `simulation_run_micro_batches` table prevented the pipeline from advancing. Additionally, if the message queue became empty, the runner would never wake up to re-evaluate the state or prune these dead tasks.

### Solution & Implementation
We implemented a **Supervisor Pattern** supported by a periodic **Watchdog Heartbeat**:

- **Watchdog Heartbeat**: Added `processResiliencyHeartbeat` to the scheduled CRON worker. It periodically dispatches `simulation-advance` messages to all active runs (status: `running`, `busy_running`, or `awaiting_documents`), ensuring the system "ticks" even if the queue is idle.
- **Supervisor Interface**: Added a mandatory `recoverZombies` method to the `PipelineRegistryEntry` interface. The `Simulation Runner` now invokes this method on every tick before processing new work.
- **Zombie Sweeper**: Implemented `recoverMicroBatchZombies` for the `micro_batches` phase. It identifies items in `enqueued` status that haven't been updated in over 15 minutes and marks them as `failed` with a `ZOMBIE_TIMEOUT` error. This allows the phase to reach its terminal condition and proceed.
- **Refactor**: Decoupled phase definitions from the Web UI by moving entry points from `src/app/pipelines/<phase>/web/index.ts` to `src/app/pipelines/<phase>/index.ts`.

### Validation
- **Micro-Batch Sweeper**: Verified logic for identifying and updating `enqueued` items with stale `updated_at` timestamps.
- **Heartbeat Logic**: Verified that active simulations are correctly identified and "poked" via the indexing queue.