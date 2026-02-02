# Simulation Engine Blueprint

## 1. Purpose

The Simulation Engine serves two critical roles:
1.  **Historical Backfill**: Processing past data to build the Knowledge Graph.
2.  **Logic Validation**: Verifying that new logic (e.g., linking rules) produces expected results on known datasets.

It is designed to be **Deterministic**, **Restartable**, and **Inspectable**.

## 2. Core Architecture: The Unified Pipeline

To prevent logic drift, the Simulation Engine and the Live Pipeline share the exact same **Phase Logic**.

### 2.1 Co-located Domain Logic
All logic is organized by **Domain**, not by Runtime. We strictly adhere to the `src/app/pipelines/<phase>/` directory structure.
*   **Core**: The Shared Business Logic (`engine/core/`) - **THIS IS THE SOURCE OF TRUTH.**
*   **Live**: Adapters for Live execution (`engine/live/`)
*   **Simulation**: Adapters for Simulation execution (`engine/simulation/`)

**CRITICAL CONSTRAINT**: There are **NO PER-PHASE RUNNERS**. The Simulation Runner is a single, generic system that dispatches work to the Core logic.

### 2.2 Stateless Phase Execution
We cannot be "Pure" (World In -> World Out) because we cannot load the entire Graph into memory.
Instead, we use **Stateless Execution with Context**.

```typescript
type PhaseExecution<TInput, TOutput> = (
  input: TInput,
  context: SimulationDbContext // Provides DB Access, LLM, Env
) => Promise<TOutput>;
```

## 3. Storage Strategy: The "Artifacts" Table

The engine uses a single, generic **Simulation Artifacts** table to persist the state of every unit of work at every phase.

### 3.1 `simulation_run_artifacts` Table
Stores the inputs and outputs of every phase for every entity.

| Column | Type | Description |
| :--- | :--- | :--- |
| `run_id` | PK | The simulation run ID. |
| `phase` | PK | The phase name (e.g., `micro_batches`). |
| `entity_id` | PK | The unit of work (e.g., `r2_key`, `moment_id`). |
| `input_json` | JSON | The arguments passed to the phase logic. |
| `output_json` | JSON | The result returned by the phase logic. |
| `status` | Enum | `pending`, `running`, `complete`, `failed`. |
| `retry_count` | Int | Application-level retry counter. |
| `error_json` | JSON | Last error details if failed. |

## 4. Execution Models (Live vs. Simulation)

While logic is shared, the **Execution Model** differs to serve the different needs of Live (Latency) vs Simulation (Throughput/Inspectability).

### 4.1 Live Execution (Push / Event-Driven)
*   **Trigger**: Real-time events (Webhooks, Cron).
*   **Flow**: Optimistic Chain. `Adapter A` calls `Core A`, then immediately calls `Adapter B` (or enqueues to a Live Queue).
*   **State**: Ephemeral. Data moves fast; persistent traces are optional (logs only).

### 4.2 Simulation Execution (Pull / Batch-Driven)
*   **Trigger**: The Supervisor (Pacer).
*   **Flow**: Checkpointed Step. `Worker` runs `Core A`, saves result to `Artifacts` as `complete`, and inserts `Artifact B` as `pending`. It **stops** there.
*   **Role of Supervisor**:
    *   **Why do we need it?** We are processing 10,000+ items (Backfill). We cannot just "let it rip" or we will flood the queues.
    *   **The Pacer**: The Supervisor polls `pending` artifacts and dispatches them at a controlled rate (Backpressure).
    *   **Time Simulation**: By controlling the dispatch tick, we can simulate the passage of time (e.g., processing chunks in timestamp order).

## 5. Work Unit Orchestration (Simulation Only)

The Simulation Runner is a **Generic Artifact Processor**.

### 5.1 The Loop (Supervisor)
1.  **Poll**: Queries `simulation_run_artifacts` for `pending` items (limited by concurrency cap).
2.  **Dispatch**: Sends a `simulation-job` message to the Queue for each item.

### 5.2 The Worker (Handler)
1.  **Read**: Reads the Artifact from DB.
2.  **Route**: Switches on `artifact.phase` to import the correct **Core Logic** from `src/app/pipelines/<phase>/engine/core/`.
3.  **Execute**: Calls the Core Logic with `(input_json, db_context)`.
4.  **Persist**: Updates Artifact: `status='complete'`, `output_json=result`.
5.  **Chain**: Inserts `pending` artifacts for the *next* phase.

## 6. The 8-Phase Lifecycle

| Phase | Input (Artifact.entity_id) | Core Logic Location | Output Artifact |
| :--- | :--- | :--- | :--- |
| **1. Ingest** | `r2_key` | `pipelines/ingest_diff/engine/core/` | `Chunks[]` |
| **2. Micro Batches** | `r2_key` | `pipelines/micro_batches/engine/core/` | `MicroMoment[]` |
| **3. Macro Synthesis** | `r2_key` | `pipelines/macro_synthesis/engine/core/` | `MacroStream[]` |
| **4. Classification** | `r2_key` | `pipelines/macro_classification/engine/core/` | `ClassifiedStream[]` |
| **5. Materialize** | `r2_key` | `pipelines/materialize_moments/engine/core/` | `Moment[]` (Graph IDs) |
| **6. Linking** | `moment_id` | `pipelines/deterministic_linking/engine/core/` | `ParentLink` |
| **7. Candidates** | `moment_id` | `pipelines/candidate_sets/engine/core/` | `Candidate[]` |
| **8. Timeline Fit** | `moment_id` | `pipelines/timeline_fit/engine/core/` | `FinalDecision` |

## 7. System Constraints

1.  **QUEUE-BASED EXECUTION**: All phase transitions MUST occur via Queue Dispatch (in Sim) or Function Chain (in Live). No long-running sync loops.
2.  **NO PER-PHASE RUNNERS**: Orchestration logic appears ONLY in the generic Supervisor. Phase directories contain ONLY domain logic.
3.  **30-Second Bound**: No phase logic may ever block for > 30s. Long tasks must be broken into sub-artifacts (e.g., batching chunks).
4.  **Statelessness**: Workers are ephemeral. All state must be persisted to `simulation_run_artifacts` before the worker exits.
5.  **No Custom Tables**: Phases MUST NOT create their own run-state tables. They must use the generic storage.
6.  **UI Visibility**: The `output_json` must contain sufficient data to render the "Audit Card" for that phase.
