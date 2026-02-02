# Unified Pipeline Investigation [2026-02-02]

## Priming: Reconciling Blueprints with Reality
We started by reviewing the existing `docs/blueprints/unified-pipeline.md` and `docs/architecture/system-flow.md`.
We highlighted a critical gap: the blueprints describe an "ideal" state that may not match the actual code, specifically regarding "Stateless Execution" and the integration of "Plugins".
We also need to incorporate a concrete "Prefetching" example to illustrate the end-to-end flow.

## Investigated the Plugin Architecture
We examined `src/app/engine/plugins` and specifically `github.ts` to understand where domain logic lives.
**Findings:**
*   Plugins are the "Domain Drivers". `github.ts` implements interfaces for `prepareSourceDocument` (Ingest), `splitDocumentIntoChunks` (Micro-Batching), and `getMicroMomentBatchPromptContext` (Prompting).
*   This confirms that "Ingestion" and "Diffing" logic is largely delegated to these plugins, which fits the "Unified" model (logic is shared).

## Investigated Micro-Bubbles & Statelessness
We looked at `src/app/pipelines/micro_batches/engine/core/orchestrator.ts` and `src/app/engine/types.ts`.
**Findings:**
*   **Micro-Batching**: The `MicroBatchesOrchestrator` takes `chunkBatches` and produces `MicroMoment` items. It uses a "Ports" pattern (`MicroBatchesOrchestratorPorts`) to decouple logic from I/O, which supports the "Stateless" goal.
*   **Context**: `IndexingHookContext` (in `types.ts`) carries the `env` and `momentGraphNamespace`, effectively acting as the "Side-Effect Handle" passed to stateless functions.
*   **Terminology**: The code uses `MicroMoment` (embeddings) and `MacroMoment` (synthesis), which aligns with the user's mental model, but the blueprints need to be explicit about this distinction.
## Consensus: Architecture Alignment
We agreed on the following definitions which will now be codified in the blueprints.

### 1. The "Stateless" Constraint
*   **Definition**: A worker process never holds the graph in memory. It holds only the **active ID** and a **Context Handle**.
*   **Mechanism**: All state access is explicit via . This forces us to acknowledge every database roundtrip.
*   **Sync vs Async**: We accept that "Candidate Generation" relies on data *already being in the DB*. In Live mode, this is eventually consistent (race conditions acceptable). In Sim mode, the Supervisor orchestrates order.

### 2. The Phase I/O Contract
We will document each phase with explicit IO definitions:
*   **Input**: The ID trigger.
*   **Context Read**: What it fetches from the DB.
*   **Context Write**: What it commits to the DB.
*   **Output**: The resulting Artifact/ID for the next phase.

### 3. Terminology
*   **Micro-Batch**: A set of Chunks + Embeddings (Vector-ready).
*   **Materialize**: The  into the primary graph tables.


## Identified Legacy Files
We searched the codebase to identify the legacy components that need to be changed or removed as part of the Unified Pipeline migration.

### Files to Remove (Legacy Rot)
These files represent the "Distributed Runner" pattern and "Legacy Phase Adapters" that are being replaced by the Unified Orchestrator.

1.  **Per-Phase Runners** (`src/app/pipelines/*/engine/simulation/runner.ts`):
    *   `micro_batches/engine/simulation/runner.ts`
    *   `ingest_diff/engine/simulation/runner.ts`
    *   `macro_synthesis/engine/simulation/runner.ts`
    *   `macro_classification/engine/simulation/runner.ts`
    *   `materialize_moments/engine/simulation/runner.ts`
    *   `deterministic_linking/engine/simulation/runner.ts`
    *   `candidate_sets/engine/simulation/runner.ts`
    *   `timeline_fit/engine/simulation/runner.ts`
    *   `r2_listing/engine/simulation/runner.ts`

2.  **Legacy Adapters** (`src/app/pipelines/*/engine/simulation/adapter.ts`):
    *   `micro_batches/engine/simulation/adapter.ts`
    *   `macro_classification/engine/simulation/adapter.ts`
    *   `materialize_moments/engine/simulation/adapter.ts`
    *   (And others if they exist in variations, e.g. `macro_synthesis` has `live/adapter.ts` and `simulation/adapter.ts`)

3.  **Pipeline-Specific Routes** (`src/app/pipelines/*/web/routes/*.ts`):
    *   Confirmed in `src/app/pipelines/micro_batches/web/routes/`
    *   These expose endpoints that query legacy tables and should be removed in favor of the generic admin API.

### Files to Change/Refactor
1.  **Central Runner** (`src/app/engine/runners/simulation/runner.ts`):
    *   This is the current entry point. It needs to be updated to use the new `UnifiedRun Orchestrator` or be replaced by it.
2.  **Simulation Routes** (`src/app/engine/routes/simulation.ts`):
    *   Remove `getSimulationRunDebugStatusHandler`.
    *   Update other handlers to respect the new schema if needed.
3.  **Core Orchestrators** (`src/app/pipelines/*/engine/core/orchestrator.ts`):
    *   These contain the valid business logic but use the "Ports" pattern.
    *   Action: Refactor to usage `PipelineContext` directly and remove Ports.
