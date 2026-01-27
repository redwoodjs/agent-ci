# Simulation Run Investigation - 2026-01-27

## Starting investigation into stalled production build
We are investigating run `053ffe62-3a48-4f53-8422-0f926646d0e7` which is stalled in production.
We also need to update architecture blueprints for the simulation engine and debug endpoints.

### Plan
<!-- Work Task Blueprint -->
#### Directory & File Structure
- `docs/blueprints/simulation-engine.md`: Update with registry design, watchdog, and resiliency details.
- [NEW] `docs/blueprints/debug-endpoints.md`: Document the design and pattern for investigation endpoints.

#### Types & Data Structures
- Document `PipelineRegistryEntry` and its role in phase recovery and execution.

#### Invariants & Constraints
- **Watchdog Invariant**: A run status of `busy_running` must not persist longer than 5 minutes without being broken by the watchdog.
- **Zombie Invariant**: A document in `dispatched` but not `processed` for >5 minutes must be recovered.

#### System Flow (Snapshot Diff)
- **Watchdog Loop**: `Cron` -> `processResiliencyHeartbeat` -> `ENGINE_INDEXING_QUEUE` -> `processSimulationJob` -> `advanceSimulationRunPhaseNoop` -> `recoverZombies`.

#### Natural Language Context
Rationale: The production build is stalled despite the presence of a watchdog. We need to verify if the watchdog is firing and why it's failing to recover this specific run.

#### Suggested Verification (Manual)
1. Check production logs for `[resiliency]` and `[simulation-worker]` tags.
2. Query production DB for the `updated_at` and `status` of run `433c585c-4a5c-4cdc-862c-a7ded0a25f58`.
3. Check the logs for runId `433c585c-4a5c-4cdc-862c-a7ded0a25f58` in `/tmp/sim-prd.log`.
4. Verify if any documents for this run are in a "zombie" state (dispatched but not processed for >5 mins).

### Tasks
- [x] Update Simulation Engine Blueprint with registry and watchdog details
- [x] Create Debug Endpoints Blueprint
- [/] Investigate stalled run `433c585c-4a5c-4cdc-862c-a7ded0a25f58`
    - [x] Search for runId `433c585c-4a5c-4cdc-862c-a7ded0a25f58` in `/tmp/sim-prd.log`
    - [ ] Check logs for heartbeat activity
    - [ ] Check for zombie documents
    - [ ] Add more granular logging to heartbeat and lock breaking if needed
- [ ] Implement improvements to heartbeat visibility
