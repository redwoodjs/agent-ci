# Simulation Engine Blueprint

**Status**: Living Document
**Last Updated**: 2026-01-26

## 1. Purpose

The Simulation Engine allows us to run the entire Machinen pipeline on historical data in a **deterministic, restartable, and inspectable** way. It is the primary tool for "Backfilling" and "Validating" logic changes.

## 3. Core Components

### 3.1 The Pipeline Registry
Every phase of the simulation is defined as a `PipelineRegistryEntry` and registered via `registerPipeline`. This allows for a modular design where each phase defines its own logic, routes, and UI.

```typescript
export type PipelineRegistryEntry = {
  phase: SimulationPhase;
  label: string;
  runner: (context: SimulationDbContext, input: { runId: string; phaseIdx: number; ... }) => Promise<...>;
  web?: {
    routes?: any[];
    ui?: { summary?: ...; drilldown?: ...; };
  };
  recoverZombies: (context: SimulationDbContext, input: { runId: string }) => Promise<void>;
};
```

### 3.2 The Watchdog (Heartbeat)
To ensure the simulation doesn't stall due to worker failures or dropped messages, a **Resiliency Heartbeat** runs periodically (via cron).

1.  **Heartbeat**: `processResiliencyHeartbeat` scans for active runs (`running`, `busy_running`, `awaiting_documents`).
2.  **Poke**: It enqueues a `simulation-advance` job for each active run.
3.  **Lock Breaking**: `advanceSimulationRunPhaseNoop` will break a `busy_running` lock if the `updated_at` is older than 5 minutes.
4.  **Zombie Recovery**: Before running the phase logic, the host calls `recoverZombies`.

### 3.3 Zombie Recovery
Each phase MUST implement `recoverZombies`. Typically, this uses `recoverZombiesForPhase`, which:
*   Scans `simulation_run_documents` for documents dispatched to the current phase but not yet processed.
*   Resets the `dispatched_phases_json` if the document hasn't been updated in 5 minutes.
*   Allows the next `runner` tick to re-dispatch the document.

## 4. Data Model

| Table | Purpose | Key Identity |
| :--- | :--- | :--- |
| `simulation_runs` | Run state & config | `run_id` |
| `simulation_run_documents` | Per-doc progress & change tracking | `run_id`, `r2_key` |
| `simulation_run_micro_batches` | Cached batch outputs | `batch_hash` |
| `simulation_run_materialized_moments` | Moment ID mapping (Sim -> Graph) | `run_id`, `moment_id` |
| `simulation_run_link_decisions` | Why a link was made/rejected | `run_id`, `child_moment_id` |

## 5. Invariants

*   **No Synchronous Loops**: The Host Runner must never loop indefinitely. It must do a bounded scan and exit.
*   **Watchdog Guaranteed**: A simulation run must eventually progress or fail if the environment is healthy. `busy_running` is a temporary lock, not a permanent state.
*   **Zombie Recovery**: The engine must recover runs that stalled due to dropped queue messages or worker crashes.
*   **Isolation**: A simulation run operates in its own "Lane". It should not affect other runs.
*   **Determinism**: Simulation runs, including sampled subsets, must be deterministic and reproducible. Sampling must support seeding.
