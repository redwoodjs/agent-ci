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

## RFC: Liveness Protection Layer

### 1. 2000ft View Narrative
**Problem**: Simulation runs on large datasets (~200+ docs) or after manual restarts consistently fail due to "Zombie Ditching". This is caused by a restrictive 5-minute timeout that is triggered by (a) queue congestion where documents wait > 5m to be picked up, and (b) simulation restarts where documents retain ancient `updated_at` timestamps from original ingestion.
**Solution**: We will implement a "Liveness Protection" layer that decouples "Queue Wait Time" from "Active Processing Time" and ensures that any reset or restart operation forcefully refreshes document timestamps. We will also increase the absolute threshold to 30 minutes to provide a safer buffer for local serial processing.

### 2. Database Changes
No schema changes. We are utilizing existing fields (`updated_at`).

### 3. Behavior Spec
- **GIVEN** a simulation run is restarted from a phase
- **WHEN** the runner resets the document states
- **THEN** it must also update the `updated_at` timestamp for all affected documents to `now()`.

- **GIVEN** a Simulation Worker receives a job from the queue
- **WHEN** it begins processing
- **THEN** it must immediately update the document's `updated_at` timestamp (The Pick-Up Latch) before executing the phase logic.

### 4. API Reference
No changes to public APIs. Internal behavior modifications only.

### 5. Implementation Breakdown
- [MODIFY] [runner.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/runners/simulation/runner.ts): Increase `zombieThreshold` to 30m and polling limits to 100.
- [MODIFY] [runs.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/simulation/runs.ts): Add `updated_at` refresh to `restartSimulationRunFromPhase`.
- [MODIFY] [simulation-worker.ts](file:///Users/justin/rw/worktrees/machinen_y-no-materialize/src/app/engine/services/simulation-worker.ts): Implement Pick-Up Latch.

### 6. Directory & File Structure
```text
src/app/engine/
├── runners/simulation/runner.ts
├── simulation/runs.ts
└── services/simulation-worker.ts
```

### 7. Types & Data Structures
No changes to existing types.

### 8. Invariants & Constraints
- **Invariant**: A document's `updated_at` must represent its last known "life sign", which includes either (a) being dispatched, (b) being picked up by a worker, or (c) completing a phase.

### 9. System Flow (Snapshot Diff)
**Previous Flow**:
1. Runner dispatches job -> sets `updated_at`.
2. Document sits in queue. If > 5m, supervisor ditches it.
3. Worker picks up, processes (takes time), then sets `updated_at` on completion.

**New Flow**:
1. Runner dispatches job -> sets `updated_at` -> **30m window starts**.
2. Document sits in queue.
3. Worker picks up -> **IMMEDIATELY refreshes `updated_at`** -> **window resets**.
4. Worker processes (window is safe).
5. Worker completes -> resets `updated_at` again.

### 10. Suggested Verification
- Manual verification: `pnpm run sim-restart --run-id <ID> --phase micro_batches`
- Check `sim.log` for logs: `[runner] Recovering X zombies` (should be 0 for active runs).

### 11. Tasks
- [ ] Increase `zombieThreshold` to 30 minutes in `runner.ts`.
- [ ] Boost dispatch polling limits to 100 in `runner.ts`.
- [ ] Implement Pick-Up Latch in `processSimulationJob` in `simulation-worker.ts`.
- [ ] Add `updated_at: now` to document resets in `runs.ts`.
- [ ] Update `runtime-architecture.md` to reflect the 30-minute ditching rule.
