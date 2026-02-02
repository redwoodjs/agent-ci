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
*   **Web**: UI Components (`web/ui/`)
*   **Core**: The Shared Business Logic (`engine/core/`) - **THIS IS THE SOURCE OF TRUTH.**
*   **Live**: Adapters for Live execution (`engine/live/`)
*   **Simulation**: Adapters for Simulation execution (`engine/simulation/`)

**CRITICAL CONSTRAINT**: There are **NO PER-PHASE RUNNERS**. The Simulation Runner is a single, generic system that dispatches work to the Core logic.

### 2.2 Stateless Phase Execution (The Memory Solution)
We cannot be "Pure" (World In -> World Out) because we cannot load the entire Graph into 128MB of memory.
Instead, we use **Stateless Execution with Context**.

```typescript
type PhaseExecution<TInput, TOutput> = (
  input: TInput,
  context: SimulationDbContext // Provides DB Access, LLM, Env
) => Promise<TOutput>;
```
*   **Input**: The specific Artifact Input (e.g., `r2_key`, `moment_id`).
*   **Context**: Allows the phase to *query* the DB for exactly what it needs (e.g., "Find top 10 candidates").
*   **Output**: The result to be stored as the Output Artifact.

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

### 3.2 Value
1.  **Generic Polling**: The Runner simply queries: `SELECT * FROM artifacts WHERE status = 'pending'`.
2.  **UI Inspectability**: The UI renders `output_json` for any phase without custom DB queries.
3.  **Checkpointing**: If a run crashes, resumption occurs exactly where it left off.

## 4. Work Unit Orchestration

The Simulation Runner is a **Generic Artifact Processor**.

### 4.1 The Loop (Generic Supervisor)
1.  **Poll**: Queries `simulation_run_artifacts` for `pending` items.
2.  **Dispatch**: Sends a `simulation-job` message to the Queue for each pending item.

### 4.2 The Worker (Generic Handler)
1.  **Read**: Reads the Artifact from DB.
2.  **Route**: Switches on `artifact.phase` to import the correct **Core Logic** from `src/app/pipelines/<phase>/engine/core/`.
3.  **Execute**: Calls the Core Logic with `(input_json, db_context)`.
4.  **Persist**: Updates Artifact: `status='complete'`, `output_json=result`.
5.  **Chain**: Inserts `pending` artifacts for the *next* phase.

## 5. The 8-Phase Lifecycle

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

## 6. Resilience & Retries

### 6.1 Application-Level Retries
The orchestrator tracks a `retry_count` on the Artifact row.
*   **Logic Failure**: (e.g., LLM Refusal). Catch error -> Increment `retry_count` -> Update DB -> Ack Message.
*   **Give Up**: If `retry_count > 3`, set `status='failed'`. We stop processing this unit.

### 6.2 Infra-Level Retries (DLQ)
*   **Crash/Timeout**: If the Worker OOMs or Times Out, the Cloudflare Queue mechanism catches it.
*   **Policy**: `max_retries: 3`. If fails 3 times, moves to Dead Letter Queue (DLQ).
*   **Recovery**: The System Heartbeat occasionally scans for "stuck" `running` artifacts (older than 5 mins) and resets them to `pending` (Zombie Recovery).

## 7. Invariants

1.  **NO PER-PHASE RUNNERS**: Orchestration logic appears ONLY in the generic Supervisor. Phase directories contain ONLY domain logic.
2.  **30-Second Bound**: No phase logic may ever block for > 30s. Long tasks must be broken into sub-artifacts (e.g., batching chunks).
3.  **Statelessness**: Workers are ephemeral. All state must be persisted to `simulation_run_artifacts` before the worker exits.
4.  **No Custom Tables**: Phases MUST NOT create their own run-state tables. They must use the generic storage.
5.  **UI Visibility**: The `output_json` must contain sufficient data to render the "Audit Card" for that phase.
