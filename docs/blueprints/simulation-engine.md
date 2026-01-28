# Simulation Engine Blueprint

## 1. Purpose

The Simulation Engine allows us to run the entire Machinen pipeline on historical data in a **deterministic, restartable, and inspectable** way. It is the primary tool for "Backfilling" and "Validating" logic changes.

## 2. Execution Roles

The simulation engine distinguishes between two primary roles:

### 2.1 The Supervisor (The "Manager")
The **Supervisor** is responsible for high-level state transitions and job dispatching. 
*   **System Actor**: Primarily invoked by the **Resiliency Heartbeat** (a scheduled cron job/watchdog).
*   **Logic**: Resides in `engine/runners/simulation/runner.ts`.
*   **Responsibilities**:
    *   Scanning for active runs.
    *   Determining the current phase.
    *   Asking the phase what units need work (via `onTick`).
    *   Dispatching jobs to the execution queue.
    *   Handling host crashes to ensure the run never stalls.

### 2.2 The Handler (The "Worker")
The **Handler** is responsible for processing granular units of work.
*   **System Actor**: Invoked by a **Cloudflare Queue worker** when it receives a job message.
*   **Logic**: Resides in the specific phase runner's `onExecute` implementation.
*   **Responsibilities**:
    *   Stateless processing of a single **Work Unit** (e.g., `document`, `batch`).
    *   Performing the actual processing (LLM calls, compute, indexing).
    *   Logging granular failures (`phase.doc_error`).

## 3. Core Components

### 3.1 The Pipeline Registry
Every phase of the simulation is defined as a `PipelineRegistryEntry`. Each entry defines a split responsibility between host orchestration and worker execution to ensure consistent retry behavior.

#### Work Units
We use a `WorkUnit` discriminated union to handle different granularities of work:
*   `document`: A single R2 key.
*   `batch`: A specific micro-batch index within a document.
*   `custom`: Extensibility point for future chunk types.

#### Registry Entry Structure

The `PipelineRegistryEntry` is a **shared contract** that defines all behaviors for a phase. The system routes to specific callbacks based on the current execution context:

```typescript
export type PipelineRegistryEntry = {
  phase: SimulationPhase;
  label: string;
  // SUPERVISOR context: Called by the heartbeat to poll/dispatch work
  onTick: (context: SimulationDbContext, input: { runId: string; phaseIdx: number }) => Promise<{ status: string; currentPhase: string } | null>;
  // HANDLER context: Called by the queue worker to process a specific WorkUnit
  onExecute: (context: SimulationDbContext, input: { runId: string; workUnit: WorkUnit }) => Promise<void>;
  recoverZombies: (context: SimulationDbContext, input: { runId: string }) => Promise<void>;
};
```

### 3.2 The Watchdog (Heartbeat)
To ensure the simulation doesn't stall due to worker failures or dropped messages, a **Resiliency Heartbeat** runs periodically (via cron).

1.  **Heartbeat**: `processResiliencyHeartbeat` scans for active runs (`running`, `busy_running`, `awaiting_documents`).
2.  **Poke**: It enqueues a `simulation-advance` job for each active run.
3.  **Lock Breaking**: `advanceSimulationRunPhaseNoop` will break a `busy_running` lock if the `updated_at` is older than 5 minutes. The host runner's guard check explicitly permits stale `busy_running` locks to bypass the early return.
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
*   **Determinism**: Simulation runs, including sampled subsets, must be deterministic and reproducible. Sampling must support seeding via `fictional`.
*   **Mixed Sampling**: The engine supports combining explicitly defined R2 keys with a sampled set. When mixed, all explicit keys are included, and additional keys are sampled up to the requested size. The final combined list is deterministically shuffled to ensure representative ordering.
*   **Indexing Isolation**: Simulation runs MUST index moments into the vector store via the unified `addMoment` path to ensure candidate acquisition works identically to live environments.
*   **Observability (In-Process Logging)**: Engine-level rejections (e.g., time-order or cycle prevention) must be routed to simulation run events using the `MomentGraphLogger` interface to surface discarded link candidates.
