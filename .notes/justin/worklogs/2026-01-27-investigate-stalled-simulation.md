# Simulation Run Investigation - 2026-01-27

## Starting investigation into stalled production build
We are investigating run `053ffe62-3a48-4f53-8422-0f926646d0e7` which is stalled in production.
We also need to update architecture blueprints for the simulation engine and debug endpoints.

### Plan
<!-- Work Task Blueprint -->
#### Directory & File Structure
```tree
src/app/
├── engine/
│   ├── runners/
│   │   └── simulation/
│   │       └── runner.ts          # [MODIFY] Wrap phase runner in try...finally for lock safety
│   ├── routes/
│   │   └── simulation.ts          # [MODIFY] Add debug endpoints for doc status
│   └── simulation/
│       └── resiliency.ts          # [REFERENCE] For recoverZombiesForPhase
└── pipelines/
    └── micro_batches/
        └── engine/
            └── simulation/
                └── sweeper.ts     # [MODIFY] Add document-level zombie recovery
```

#### Types & Data Structures
- No new types, but leveraging `PipelineRegistryEntry` for better recovery orchestration.

#### Invariants & Constraints
- **Lock Invariant**: `busy_running` must be reset to `running` or `awaiting_documents` (or `failed`) in the `finally` block of `advanceSimulationRunPhaseNoop`.
- **Sweep Invariant**: `micro_batches` must sweep both `simulation_run_micro_batches` (batches) AND `simulation_run_documents` (documents).

#### System Flow (Snapshot Diff)
```diff
  // runner.ts
- await entry.runner(context, { ... });
- await db.updateTable("simulation_runs").set({ status: "running" }).where("run_id", "=", runId).execute();
+ try {
+   const result = await entry.runner(context, { ... });
+   // ... update status based on result
+ } finally {
+   // Ensure status is NOT busy_running if we crashed
+   if (currentStatus === 'busy_running') {
+     await setSimulationRunStatus(context, { runId, status: 'running' });
+   }
+ }
```

#### Rationale
The `busy_running` lock is currently "leaky" because it relies on the runner completing successfully to reset the status. If the runner crashes or is killed, the lock persists until the 5-minute watchdog timeout. Furthermore, `micro_batches` only recovers stuck batches, meaning a document that fails to even plan its batches (pre-orchestration) stays "dispatched" forever.

#### Suggested Verification (Manual)
1. **Runner Lock**: Manually trigger a runner error (e.g., via temporary `throw`) and verify the DB status returns to `running` immediately.
2. **Micro Batch Sweep**: Manually set a doc to `dispatched` for `micro_batches` but not `processed`, wait for sweep timeout, and verify it's recovered.
3. **Debug API**: Call `GET /admin/simulation/run/:runId/debug/status` and verify the output.

### Tasks
- [x] Update Simulation Engine Blueprint with registry and watchdog details
- [x] Create Debug Endpoints Blueprint
- [x] Investigate stalled run `433c585c-4a5c-4cdc-862c-a7ded0a25f58`
    - [x] Search for runId `433c585c-4a5c-4cdc-862c-a7ded0a25f58` in `/tmp/sim-prd.log`
    - [x] Check logs for heartbeat activity (verified via UI snapshots showing staleness)
    - [x] Check for zombie documents (confirmed missing document-level recovery in micro_batches)
- [x] Implement Work Task Blueprint fixes
    - [x] Fix lock leak in `runner.ts`
    - [x] Add document recovery to `micro_batches/sweeper.ts`
    - [x] Add debug status endpoint to `routes/simulation.ts`
- [x] Verify fixes
    - [x] Create walkthrough documenting changes
    - [x] Suggest manual verification steps to user
- [ ] Implement improvements to heartbeat visibility
- [ ] Implement improvements to heartbeat visibility
## PR Draft: Implement Lock Safety and Document-Level Zombie Recovery

### Problem
The simulation engine's `busy_running` lock was "leaky." If a phase runner crashed or encountered a database error, the lock would remain in the database until the 5-minute watchdog timeout, stalling progress and potentially re-locking immediately after the watchdog broke it. Additionally, the `micro_batches` phase lacked document-level zombie recovery, meaning any document that failed during the initial dispatch/planning phase would stay "dispatched" forever, blocking the entire simulation run from advancing.

### Solution
1. **Runner Lock Robustness**: Refactored `advanceSimulationRunPhaseNoop` in `runner.ts` to use a `try...finally` block. The `finally` block ensures that if the run status is still `busy_running` (indicating an incomplete or failed pass), it is reset to `running` to allow subsequent attempts.
2. **Micro-Batch Document Recovery**: Updated the `micro_batches` sweeper to invoke `recoverZombiesForPhase`. This adds document-level recovery alongside the existing batch-level recovery, ensuring that stalled documents are re-dispatched.
3. **Debug Status Endpoint**: Added a new endpoint `GET /admin/simulation/run/:runId/debug/status` that provides a detailed breakdown of document and batch counts, including specific lists of "stalled" items (older than 5 minutes) to facilitate investigation of stalled runs.
4. **Blueprints**: Updated `docs/blueprints/simulation-engine.md` with registry and watchdog details and created `docs/blueprints/debug-endpoints.md`.

### Verification
- **Code Review**: Verified the `finally` block logic and the integration of `recoverZombiesForPhase` in the `micro_batches` sweeper.
- **Manual Verification**: Detailed in [walkthrough.md](file:///Users/justin/.gemini/antigravity/brain/7951f078-e7bc-43b0-b130-55bf11dcdfdd/walkthrough.md).
