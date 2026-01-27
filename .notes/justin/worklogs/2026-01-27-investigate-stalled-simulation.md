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
