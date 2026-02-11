# 2026-02-11 Resolving Persistent Zombie Ditching

## Investigated the persistent simulation stalls

We are investigating why simulations are stalling at the `micro_batches` phase. Preliminary evidence from @[sim.log] shows widespread "Zombie Ditching" where documents are discarded after 5 minutes of inactivity despite the system still being "live".

### Preliminary Evidence from logs
- Total documents: 204
- Phase: `micro_batches`
- Error: `phase.document_ditched` with 4 attempts.
- Observation: Documents are being ditched even when the worker is actively processing other documents. This suggests the 5-minute threshold is being exceeded while documents wait in the serial queue.

### RNA Synthesis Findings
- Architecture Blueprint (Constraint 107-111) confirms the Ditching mechanism intended to prevent infinite stalls.
- Default `zombieThreshold` is 5 minutes.
- `executePhase` is the unified code path.

## Findings: The Triple-Threat Ditching

Our investigation of the codebase has revealed three interacting flaws that guarantee document ditching in large or restarted simulations.

### 1. Queue Congestion (Congestion Death)
In `runner.ts#tickGenericDocumentPolling`, the dispatch limit for `micro_batches` is set to only **10 documents** per tick. For 200 documents, this requires 20 orchestrator ticks. Since the `zombieThreshold` is strictly 5 minutes, if the worker pool is saturated or individual documents take significant time (LLM + Embeddings), documents sitting at the back of the queue will eventually exceed the 5-minute inactivity timer before they are ever processed.

### 2. Ancient Timestamps (Restart Death)
In `runs.ts#restartSimulationRunFromPhase`, resetting a run correctly clears the phase history but **fails to "Touch" the `updated_at` timestamp** on the `simulation_run_documents`. 
- **Reproduction**: If we restart a simulation that was first run yesterday, all documents carry a timestamp from 24 hours ago. The supervisor's `recoverPhaseZombies` check sees `updated_at < (now - 5m)` and immediately flags them as zombies.

### 3. Missing Pick-Up Latch (The Race Condition)
In `simulation-worker.ts`, the worker only updates the document's `updated_at` timestamp **after** the phase execution completes.
- **Problem**: Long-running phases (like `micro_batches` or `timeline_fit`) can take minutes. If a document is picked up after waiting 4 minutes in the queue, and then takes 2 minutes to process, the supervisor will ditch it during that processing window because the timestamp hasn't moved.

## RFC: Liveness Protection Layer (Double-Reset Strategy)

### 1. 2000ft View Narrative
**Problem**: Simulation runs fail because the 5-minute "Zombie" timeout is fundamentally incompatible with (a) serial queue lag in high-throughput local runs (~200 docs), and (b) simulation restarts with stale data.
**Solution**: We implement a **Double-Reset** liveness strategy for all work units (Documents and Batches). 
1. **Reset 1 (Dispatch)**: The runner moves the clock when it enqueues the work. This window (30 minutes) covers the **Wait in Line** time.
2. **Reset 2 (Pickup)**: The worker moves the clock (The Pick-Up Latch) the millisecond it pulls the job. This covers the **Active Work** time.
3. **Restart Protection**: Any manual restart forcefully touches all involved timestamps to `now()`.

### 2. Database Changes
No schema changes. We are utilizing existing `updated_at` fields on `simulation_run_documents` and `simulation_run_r2_batches`.

### 3. Behavior Spec
- **GIVEN** a worker picks up a job (Type: `simulation-document` OR `simulation-batch`)
- **WHEN** processing begins
- **THEN** it must immediately update the corresponding database row's `updated_at` timestamp before calling the orchestrator.

- **GIVEN** a simulation run is restarted
- **WHEN** document states are reset
- **THEN** all involved `simulation_run_documents` rows MUST have `updated_at` set to `now()`.

### 4. API Reference
No changes to public interfaces.

### 5. Implementation Breakdown
- [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/runners/simulation/runner.ts): 
    - Increase `zombieThreshold` to 30m.
    - Boost polling limits to 100 for all phases.
- [MODIFY] [runs.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/simulation/runs.ts): 
    - Add `updated_at: now` to document resets in `restartSimulationRunFromPhase`.
- [MODIFY] [simulation-worker.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/services/simulation-worker.ts): 
    - Implement Pick-Up Latch for `simulation-document` jobs.
    - Implement Pick-Up Latch for `simulation-batch` jobs (Phase 1).

### 6. Directory & File Structure
```text
src/app/engine/
├── runners/simulation/runner.ts
├── simulation/runs.ts
└── services/simulation-worker.ts
```

### 7. Types & Data Structures
No changes.

### 8. Invariants & Constraints
- **Invariant**: The `updated_at` timestamp on any work unit (Document/Batch) must represent either its position in the queue (if waiting) or its active processing heartbeat (if with a worker).

### 9. System Flow (Snapshot Diff)
**Previous**: Dispatch (Start Clock) -> Queue Wait -> Processing -> Complete (End Clock/Result).
**New**: Dispatch (Start Clock 1) -> Queue Wait -> **Pickup (Start Clock 2)** -> Processing -> Complete (End Clock/Result).

### 10. Suggested Verification
- Manual rerun of the 200+ doc simulation.
- Verify zero zombies in `sim.log` after restart.

### 11. Tasks
- [ ] Increase `zombieThreshold` to 30 minutes in `runner.ts`.
- [ ] Boost dispatch polling limits to 100 in `runner.ts`.
- [ ] Implement Pick-Up Latch for Documents in `simulation-worker.ts`.
- [ ] Implement Pick-Up Latch for Batches in `simulation-worker.ts`.
- [ ] Add `updated_at: now` to document resets in `runs.ts`.
- [ ] Update `runtime-architecture.md` to reflect the 30-minute ditching rule.

## Investigated widespread 'get: Unspecified error (0)'

Our local simulation advanced successfully through `micro_batches` and `macro_synthesis` (Phase 2 & 3), but hit a brick wall in `materialize_moments` (Phase 5).

### Findings
- **Error**: 1282 occurrences of `get: Unspecified error (0)` in `sim.log`.
- **Cause**: The `limit(100)` boost increased worker concurrency to a point where the local Miniflare R2 implementation (local filesystem-backed) started failing fetch operations.
- **Trigger**: Every document in the pipeline attempts to `load()` previous artifacts via R2. At a 100-doc dispatch limit, 100 concurrent workers hit the local storage in high succession.

## RFC: Resilience Patch (Local R2 Stabilization)

### 1. 2000ft View Narrative
**Problem**: Local development infrastructure (Miniflare) cannot handle 100+ concurrent R2 `get` operations reliably, leading to "Unspecified error (0)".
**Solution**: We implement **R2 Retry Logic** in the storage strategy and moderate polling to **50 documents** per tick. This preserves the "Throughput Boost" while staying within the stability bounds of the local dev environment.

### 2. Implementation Breakdown
- [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/runners/simulation/runner.ts): Reduce `limit(100)` to `limit(50)`.
- [MODIFY] [simulation.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/runtime/strategies/simulation.ts): Add a retry loop for `bucket.get`.

### 3. Verification
- Manual rerun from `materialize_moments`.

### 4. Tasks
- [ ] Add Retry Logic to `ArtifactStorage.load` in `simulation.ts`.
- [ ] Moderate Polling limits to 50 in `runner.ts`.
