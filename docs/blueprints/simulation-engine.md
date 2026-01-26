# Simulation Engine Blueprint

**Status**: Living Document
**Last Updated**: 2026-01-26

## 1. Purpose

The Simulation Engine allows us to run the entire Machinen pipeline on historical data in a **deterministic, restartable, and inspectable** way. It is the primary tool for "Backfilling" and "Validating" logic changes.

## 2. Core Concepts

### 2.1 The Runner State Machine
A `SimulationRun` is a state machine that progresses through the 8 phases.

*   **State**: `runId`, `status` (`running`, `paused`, `completed`, `failed`), `currentPhase`.
*   **Transitions**:
    *   **Advance**: When all work for the current phase is done, the runner advances to the next phase.
    *   **Dispatch**: If work is pending (e.g., documents need processing), the runner stays in `running` (or `awaiting_documents`) and dispatches jobs to the Queue.

### 2.2 Queue-Based Execution (The "Async" Constraint)
The simulation is **strictly asynchronous**.

1.  **Host Runner**: A lightweight orchestrator (likely a Durable Object or Cron). It *never* does heavy work. It scans for work, dispatches to `ENGINE_INDEXING_QUEUE`, and returns.
2.  **Workers**: Stateless workers pick up jobs (`simulation-document`), execute the **Phase Adapter**, and write results to the DB.
3.  **Completion Signal**: Workers signal back (via DB status update or event) that a unit of work is done.

### 2.3 Artifact Persistence
Every phase MUST persist its outputs to `simulation_*` tables. This enables:
*   **Restartability**: We can wipe Phase 7 and restart it without re-running Phase 1-6.
*   **Inspectability**: We can query "Show me all candidate sets for Run X" to debug recall issues.

## 3. Data Model

| Table | Purpose | Key Identity |
| :--- | :--- | :--- |
| `simulation_runs` | Run state & config | `run_id` |
| `simulation_run_documents` | Per-doc progress & change tracking | `run_id`, `r2_key` |
| `simulation_run_micro_batches` | Cached batch outputs | `batch_hash` |
| `simulation_run_materialized_moments` | Moment ID mapping (Sim -> Graph) | `run_id`, `moment_id` |
| `simulation_run_link_decisions` | Why a link was made/rejected | `run_id`, `child_moment_id` |

## 4. Invariants

*   **No Synchronous Loops**: The Host Runner must never loop indefinitely. It must do a bounded scan and exit.
*   **Zombie Recovery**: The engine must have a "Watchdog" to recover runs that stalled due to dropped queue messages.
*   **Isolation**: A simulation run operates in its own "Lane". It should not affect other runs.
*   **Prefixing**: If configured, the `moment_graph_namespace` must be prefixed (e.g., `local-2026-01-26-...`) to avoid colliding with Production data.
